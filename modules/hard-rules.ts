// hard-rules.ts — pi 扩展：硬规则守卫（fail-open，但「响亮的」fail-open）
//
// 作用：把 AGENTS.md 里两条「说了也常被长上下文冲掉」的硬规则，从「文本」搬成「代码」——
//   ① §7 禁止 read 直读 .pdf/.docx/.pptx/.xlsx（必须先用 doc-read 的 to-md.ps1 转 md）
//   ② §8 monica 生图必须显式 -Model 'GPT Image 2.5 Flare'，且真跑前必须先读 monica-ai-workflow/SKILL.md
// 违规时用 tool_call 钩子否决本次调用，并把「正确的下一步命令」原样塞进 reason。
//
// 判定逻辑只有一份，在 ./hard-rules/rules.mjs（可被单测/回放直接 import）。
// 单测：node modules/hard-rules/test.mjs
//
// 工程纪律（同 skill-gate.ts）：
//   ① 模块加载期 / factory 体内不做任何可能抛错的事 —— 那里抛错会让整个 pi exit 1
//   ② handler 全程 try/catch，任何异常静默降级为「放行」
//   ③ 惰性 import ./hard-rules/rules.mjs，import 失败也只是不生效
//
// ── 三态开关（v1.1 新增）──────────────────────────────────────────────
//   模式：on（拦，默认）/ advise（只记不拦）/ off（停用）
//   切换：会话内输入 /hard-rules on | advise | off；/hard-rules = 查看状态
//   持久化：走 pi.appendEntry("hard-rules-state")，session_start / session_tree 时自动恢复，
//           因此 resume / 切分支后模式不丢。
//   env 兼容：PI_HARD_RULES=off 为「硬锁」——会话内无法再开启（应急开关）；
//             PI_HARD_RULES_MODE=advise 提供初值（可被会话内切换覆盖）。
//   优先级：PI_HARD_RULES=off（硬锁）> 会话内持久状态 > PI_HARD_RULES_MODE > 默认 on
//
// ── 加载自检（v1.1 新增）──────────────────────────────────────────────
//   session_start 时校验 rules.mjs 能否加载且 decide() 可用（含一次冒烟调用）。
//   成功 → 日志写 {"event":"loaded",...}，供外部脚本断言「pi 能加载本扩展」。
//   失败 → 写 {"event":"rules_check_failed","level":"error"}，并在 /hard-rules 状态里显示
//          「规则模块未加载 / 已降级为放行」——把静默 fail-open 变成可见的。
//
// ── 输出检查（v1.2 新增）──────────────────────────────────────────────
//   message_end 钩子：助手一段话说完时，按 rubric ④（无禁止收尾，扫末段）
//   + ⑤（无思维链泄露，扫全文）给这段话打分。判定在 rules.mjs 的 decideOutput()。
//   advise 档：记日志（event=output_check，含 wouldRemove 原文）+ 计数，绝不改输出；
//   on 档：命中就按行剔除末段/正文并返回 { message } 替换（必须保持同 role）；
//   本次交付默认不改输出：真改还需显式开 PI_HARD_RULES_OUTPUT_APPLY=1（见下），
//   因为现有默认档位就是 on（不能为了本次改动把默认改成别的），不另加闸的话「默认不改输出」做不到。
//   默认档位不变（仍由 initialMode() 决定）。
//   契约依据：docs/extensions.md:615-625「message_end handlers can return { message }
//   to replace the finalized message. The replacement must keep the same role.」

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");

const LOG_PATH = process.env.PI_HARD_RULES_LOG || path.join(LOG_DIR, "hard-rules.jsonl");
const STATE_ENTRY_TYPE = "hard-rules-state";
// 兜底落盘：appendEntry 需要「会话已建立」，而命令可能在会话建立前执行（如 -p "/hard-rules off"），
// 那种情况下 entry 写不进去。故再按 sessionId 落一份小文件，session_start 时 entry 找不到就查它。
const STATE_FILE = path.join(LOG_DIR, "hard-rules-state.json");
const STATE_FILE_MAX = 50;
const VERSION = "hard-rules/1.8.8";

type Mode = "off" | "advise" | "on";
const MODES: Mode[] = ["on", "advise", "off"];

let modPromise: Promise<any | null> | null = null;
function loadModule(): Promise<any | null> {
  try {
    if (!modPromise) modPromise = import("./hard-rules/rules.mjs").catch(() => null);
    return modPromise;
  } catch {
    return Promise.resolve(null);
  }
}

let fsPromise: Promise<any | null> | null = null;
function loadFs(): Promise<any | null> {
  try {
    if (!fsPromise) fsPromise = import("node:fs").catch(() => null);
    return fsPromise;
  } catch {
    return Promise.resolve(null);
  }
}

function env(name: string): string {
  try {
    return String(process.env[name] ?? "");
  } catch {
    return "";
  }
}

function initialMode(): Mode {
  if (env("PI_HARD_RULES").trim().toLowerCase() === "off") return "off";
  if (env("PI_HARD_RULES_MODE").trim().toLowerCase() === "advise") return "advise";
  return "on";
}

// 输出检查「真改」（替换成稿消息）的显式闸：默认关。
// 原因：现有默认档位就是 on，而本次交付要求「先只记录不改输出」；
//       不另加一个显式开关的话，默认就会开始改写助手输出。
// 开法：PI_HARD_RULES_OUTPUT_APPLY=1（或 on/true/yes），且档位 = on。
function outputApplyEnabled(): boolean {
  const v = env("PI_HARD_RULES_OUTPUT_APPLY").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

export default function (pi: ExtensionAPI) {
  // ── 会话内状态 ──────────────────────────────────────────────────────
  let mode: Mode = initialMode();
  const locked = env("PI_HARD_RULES").trim().toLowerCase() === "off"; // 硬锁：会话内不可开启
  const outApply = outputApplyEnabled(); // 输出检查「真改」总闸（默认关）
  let lockNote = locked ? "PI_HARD_RULES=off 硬锁生效" : "";

  // 自检结果
  let rulesOk: boolean | null = null;
  let rulesErr = "";
  let checkedAt = "";

  // 最近一次模式切换的落盘结果（供 /hard-rules status 显示）
  let lastPersist = "";
  let lastRestoredFrom = "";
  let loadReason = "";

  function sidOf(ctx: any): string {
    try {
      return String(ctx?.sessionManager?.getSessionId?.() ?? "");
    } catch {
      return "";
    }
  }

  async function readStateFile(): Promise<Record<string, any>> {
    try {
      const fs = await loadFs();
      if (!fs) return {};
      if (!fs.existsSync(STATE_FILE)) return {};
      const o = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  }

  async function writeStateFile(sid: string, m: Mode): Promise<void> {
    if (!sid) throw new Error("no session id");
    const fs = await loadFs();
    if (!fs) throw new Error("fs unavailable");
    const all = await readStateFile();
    all[sid] = { mode: m, t: new Date().toISOString() };
    // 只保留最近 STATE_FILE_MAX 条，避免无限增长
    const keys = Object.keys(all);
    if (keys.length > STATE_FILE_MAX) {
      keys.sort((a, b) => String(all[a]?.t ?? "").localeCompare(String(all[b]?.t ?? "")));
      for (const k of keys.slice(0, keys.length - STATE_FILE_MAX)) delete all[k];
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(all), "utf8");
  }

  // 判定状态
  let monicaSkillRead = false;
  let monicaSkillBlocks = 0;
  let blocks = 0;
  let advisories = 0;

  // 输出检查状态（v1.2）：命中/异常计数 + 最近一次命中原因（状态面板用）
  let outHits = 0;
  let outThinkHits = 0; // v1.7 R7：其中落在 thinking 通道（思维链复读）的次数
  // v1.8 §R7g 思维链硬闸
  let thinkGuardHits = 0; // 触发中断的次数（面板用）
  let thinkStreamChars = 0; // 当前 thinking 块已流出的字符数（thinking_delta 累加）
  let thinkGuardArmed = false; // 本次思考是否已触发过中断（防重复调 abort）
  let thinkDeltaTypes: Record<string, number> = {}; // 诊断：本轮见过的 assistantMessageEvent 类型计数
  // v1.8.7：续跑计数口径必须是「同一轮问答内」，**不是**「整个会话」。
  // 旧实现（thinkGuardStreak）只在会话内累加 → 用满 3 次后，该会话再也不发「用户消息」纠正，
  // 永久退化为只发卡片。而实际需求是：同一次提问内最多自动续跑 3 次，下次提问重新开始。
  let thinkGuardRoundHits = 0; // 本轮问答内已自动续跑次数（防「中断→重想→又超长」死循环）
  let pendingThinkGuardMsg: string | null = null; // v1.8.6：待发的硬闸提示（等 agent_settled 后再发）
  // v1.8.8（pi 1.1.0）：agent_settled 新增 aborted 字段，可区分「被取消」与「正常结束」。
  // 但 pi 的 aborted 取自 agent-session.js:689 的 `_agentRunAbortRequested`，该变量在 abort()
  // （agent-session.js:1911）里置位、**不区分调用者** —— 我们自己也会 abort（think guard 触发时），
  // 所以不能简单地 `if (aborted) return`，必须自己记「这次 abort 是不是我发的」。
  let selfAbortAt = 0; // v1.8.8：最近一次「我们自己发起 abort」的时刻（0 = 本轮不是我们 abort 的）
  let lastThinkGuardNote = ""; // 最近一次硬闸留痕（面板用）
  let outErrors = 0;
  let lastOutNote = "";
  // 输出检查「模块不可用」每会话只记一条 error，避免刷屏
  let outLoadErrLogged = false;

  // v1.8 §R7g：思维链硬闸阈值（字符数）。未设 → 默认 10000；off/0/负 → 关闭。
  // 注：delta 是字符串，所以阈值单位是「字符」，中文粗估 1 字 ≈ 0.6~1 token。
  // 2026-10-05 用户指定 50000 → 10000。
  const DEFAULT_THINK_LIMIT = 10000;
  function thinkLimit(): number {
    const raw = env("PI_HARD_RULES_THINK_LIMIT").trim().toLowerCase();
    if (raw === "off" || raw === "0" || raw === "false") return 0;
    if (!raw) return DEFAULT_THINK_LIMIT;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_THINK_LIMIT;
  }

  async function log(rec: any): Promise<void> {
    try {
      const fs = await loadFs();
      if (!fs) return;
      fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n", { encoding: "utf8" });
    } catch {
      /* 记日志失败绝不影响对话 */
    }
  }

  // 自检：能加载 + decide 存在 + 冒烟调用不抛错
  async function selfCheck(): Promise<{ ok: boolean; err: string }> {
    try {
      const mod = await loadModule();
      if (!mod) return { ok: false, err: "rules.mjs 无法加载（import 失败）" };
      if (typeof mod.decide !== "function") return { ok: false, err: "rules.mjs 缺少 decide 导出" };
      // 冒烟：拿一个必然命中的输入试跑，确认不抛错（不施加 effects）
      mod.decide({ toolName: "read", input: { path: "smoke.pdf" }, mode: "advise" });
      return { ok: true, err: "" };
    } catch (e: any) {
      return { ok: false, err: "decide() 冒烟调用抛错: " + String(e?.message ?? e) };
    }
  }

  // 恢复会话内持久化的模式
  function restoreMode(ctx: any): Mode | null {
    try {
      let entries: any[] = [];
      try {
        entries = ctx?.sessionManager?.getBranch?.() ?? [];
      } catch {
        entries = [];
      }
      if (!entries || entries.length === 0) {
        entries = ctx?.sessionManager?.getEntries?.() ?? [];
      }
      let found: Mode | null = null;
      for (const e of entries ?? []) {
        if (e && e.type === "custom" && e.customType === STATE_ENTRY_TYPE) {
          const m = String(e?.data?.mode ?? "");
          if (m === "on" || m === "advise" || m === "off") found = m as Mode;
        }
      }
      if (found) mode = found;
      return found;
    } catch {
      return null;
    }
  }

  async function onSessionBegin(ev: string, ctx: any, reason: string): Promise<void> {
    try {
      // 1) 恢复持久状态（硬锁时不允许被会话状态打开）
      const restored = restoreMode(ctx); // 主路径：会话条目
      let restoredFrom: string | null = restored ? "entry" : null;
      let m = restored;
      const sid = sidOf(ctx);
      // 兜底路径：条目里没有就查状态文件
      if (!m && sid) {
        const st = await readStateFile();
        const fm = String(st?.[sid]?.mode ?? "");
        if (fm === "on" || fm === "advise" || fm === "off") {
          m = fm as Mode;
          restoredFrom = "file";
          mode = m;
        }
      }
      if (locked) mode = "off";
      lastRestoredFrom = restoredFrom ?? "none";
      loadReason = reason;

      // 2) 自检
      const r = await selfCheck();
      rulesOk = r.ok;
      rulesErr = r.err;
      checkedAt = new Date().toISOString();

      // 3) 活体标记 + 自检结论（外部脚本断言这两行）
      await log({
        t: checkedAt,
        event: "session_start",
        hook: ev,
        reason,
        version: VERSION,
        cwd: ctx?.cwd ?? "",
      });
      await log({
        t: checkedAt,
        event: rulesOk ? "loaded" : "rules_check_failed",
        level: rulesOk ? "info" : "error",
        version: VERSION,
        mode,
        locked,
        lockNote,
        restoredMode: m ?? null,
        restoredFrom,
        sessionId: sid,
        rulesLoaded: rulesOk,
        rulesError: rulesErr,
        logPath: LOG_PATH,
        cwd: ctx?.cwd ?? "",
      });
    } catch {
      /* 会话开始阶段出问题不影响对话 */
    }
  }

  pi.on("session_start", async (event: any, ctx: any) => {
    await onSessionBegin("session_start", ctx, String(event?.reason ?? ""));
  });

  // 切分支 / 树导航后同样恢复（模式与自检结论都要重新对齐当前分支）
  pi.on("session_tree", async (event: any, ctx: any) => {
    await onSessionBegin("session_tree", ctx, String(event?.reason ?? ""));
  });

  // ── /hard-rules 命令 ────────────────────────────────────────────────
  function statusText(): string {
    const lines: string[] = [];
    lines.push(`扩展 ${VERSION} ｜ 当前模式：${mode}${locked ? "（env 硬锁）" : ""}`);
    lines.push(
      rulesOk === null
        ? "自检：尚未运行（本会话未触发 session_start）"
        : rulesOk
          ? "自检：规则模块已加载 ✅"
          : `自检：规则模块未加载 ❌ 已降级为放行 — ${rulesErr || "原因不明"}`,
    );
    lines.push(`自本次加载起：拦截 ${blocks} 次 / 试运行告警 ${advisories} 次（reload 会清零）`);
    lines.push(`monica：已读 SKILL.md=${monicaSkillRead ? "是" : "否"}，因未读被拦=${monicaSkillBlocks} 次`);
    {
      const outHow =
        mode !== "on"
          ? mode === "advise"
            ? "只记录"
            : "不检查"
          : outApply
            ? "真改末段"
            : "只记录；真改需 PI_HARD_RULES_OUTPUT_APPLY=1";
      lines.push(
        `输出检查：命中 ${outHits} 次（其中思维链复读 ${outThinkHits} 次）/ 异常 ${outErrors} 次（本档=${mode}，${outHow}）` +
          (thinkGuardHits ? `｜思维链硬闸已中断 ${thinkGuardHits} 次` : "") +
          (lastOutNote ? `（最近一次：${lastOutNote}）` : ""),
      );
    }
    lines.push(`日志：${LOG_PATH}`);
    if (lastRestoredFrom) lines.push(`模式来源：${lastRestoredFrom}（entry=会话条目 / file=兜底文件 / none=默认）`);
    if (loadReason) lines.push(`加载原因：${loadReason}（startup / reload / new / resume / fork）`);
    if (lastPersist) lines.push(`上次切换落盘：${lastPersist}`);
    if (mode === "advise") lines.push("⚠️ advise 模式：只记录不拦截");
    if (mode === "off") lines.push("⚠️ off 模式：守卫不生效（read 直读文档 / monica 参数缺失都不会被拦）");
    if (locked) lines.push("开关被 PI_HARD_RULES=off 锁定：需去掉该环境变量才能开启");
    lines.push("用法：/hard-rules on | advise | off   （不带参数 = 查看状态）");
    return lines.join("\n");
  }

  try {
    pi.registerCommand("hard-rules", {
      description: "硬规则守卫：查看状态 / 切换模式（on | advise | off）",
      getArgumentCompletions: (prefix: string) => {
        try {
          const items = ["status", ...MODES].filter((v) => v.startsWith(String(prefix ?? "")));
          return items.length > 0 ? items.map((v) => ({ value: v, label: v })) : null;
        } catch {
          return null;
        }
      },
      handler: async (args: any, ctx: any) => {
        try {
          const a = String(args ?? "").trim().toLowerCase();
          if (!a || a === "status") {
            if (rulesOk === null) {
              // 交互式会话里 session_start 可能已跑过；这里补一次自检，保证状态可查
              const r = await selfCheck();
              rulesOk = r.ok;
              rulesErr = r.err;
              checkedAt = new Date().toISOString();
            }
            ctx?.ui?.notify?.(statusText(), rulesOk === false ? "warn" : "info");
            return;
          }
          if (!MODES.includes(a as Mode)) {
            ctx?.ui?.notify?.(`未知参数「${a}」。用法：/hard-rules on | advise | off`, "warn");
            return;
          }
          if (locked) {
            ctx?.ui?.notify?.(`开关被环境变量 PI_HARD_RULES=off 锁定，无法切到 ${a}。`, "warn");
            await log({ t: new Date().toISOString(), event: "mode_change_rejected", wanted: a, reason: "env-locked", mode });
            return;
          }
          const prev = mode;
          mode = a as Mode;
          const errs: string[] = [];
          let entryOk = false;
          try {
            pi.appendEntry(STATE_ENTRY_TYPE, { mode, t: new Date().toISOString(), version: VERSION });
            entryOk = true;
          } catch (e: any) {
            errs.push("entry: " + String(e?.message ?? e));
          }
          let fileOk = false;
          try {
            await writeStateFile(sidOf(ctx), mode);
            fileOk = true;
          } catch (e: any) {
            errs.push("file: " + String(e?.message ?? e));
          }
          lastPersist = `entry=${entryOk ? "ok" : "fail"} file=${fileOk ? "ok" : "fail"}`;
          await log({
            t: new Date().toISOString(),
            event: "mode_change",
            from: prev,
            to: mode,
            entryOk,
            fileOk,
            persistErrors: errs.join(" | "),
            sessionId: sidOf(ctx),
            cwd: ctx?.cwd ?? "",
          });
          const how = entryOk
            ? "已写入会话（resume 后仍生效）"
            : fileOk
              ? "会话条目不可用，已落兜底状态文件"
              : "⚠️ 未能持久化：" + errs.join("; ");
          ctx?.ui?.notify?.(`hard-rules 模式：${prev} → ${mode}（${how}）`, entryOk || fileOk ? "info" : "warn");
        } catch (e: any) {
          try {
            ctx?.ui?.notify?.("hard-rules 命令出错（已忽略）：" + String(e?.message ?? e), "warn");
          } catch {
            /* 忽略 */
          }
        }
      },
    });
  } catch {
    /* 注册命令失败不影响 tool_call 守卫 */
  }

  // ── §7 前置提醒（v1.6）：用户消息里带文档文件名 → 请求开始就注入一行 ────────
  // 与 tool_call 守卫的分工：那里是「我已经去直读」才拦（事后）；这里还没动手就先说清读法。
  // 只在 mode=on 时注入；advise 只留痕；同一会话同一个文件名只提醒一次（读法说清就不必每轮重复）。
  // 关法：PI_HARD_RULES_DOC_REMINDER=off（或 /hard-rules off）。
  const docSeen = new Set<string>();
  pi.on("before_agent_start", async (event: any) => {
    try {
      if (mode === "off") return undefined;
      if (env("PI_HARD_RULES_DOC_REMINDER").trim().toLowerCase() === "off") return undefined;
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      // 斜杠命令 / 已被 skill-gate 改写加载的技能 → 不打扰（技能全文已进上下文）
      if (!prompt.trim() || prompt.trimStart().startsWith("/")) return undefined;
      const mod = await loadModule();
      if (!mod || typeof mod.decideDocReminder !== "function") return undefined;
      const d = mod.decideDocReminder({ prompt, seen: Array.from(docSeen), mode });
      if (!d || d.hit !== true) return undefined;
      for (const t of d.fresh) if (docSeen.size < 50) docSeen.add(String(mod.docKey ? mod.docKey(t) : t));
      await log({
        t: new Date().toISOString(),
        event: "doc_reminder",
        level: "info",
        at: "before_agent_start",
        version: VERSION,
        mode,
        tokens: d.tokens,
        fresh: d.fresh,
        injected: d.inject === true,
        reason: d.reason,
      });
      if (d.inject !== true) return undefined;
      const content = typeof mod.docReminderText === "function" ? mod.docReminderText(d.fresh) : "";
      if (!content) return undefined;
      return { message: { customType: "hard-rules-doc", content, display: true } };
    } catch {
      return undefined; // 任何意外 → 不注入，绝不阻断请求
    }
  });

  // ── §R7g 思维链硬闸（v1.8）：单次思考超阈值 → 直接中断本轮 ──────────
  // 与 R7 删行的分工：删行是事后抹痕迹；这里是在流式过程中拦住（不让它写完）。
  // 依据：thinking 块只通过 thinking_delta 增长（pi-ai/dist/types.d.ts:586），
  //   故用 delta 累加 → O(1)/次，无需遍历 content。
  // 中断：ctx.abort()（ExtensionContext，types.d.ts:242）。
  // 阈值：PI_HARD_RULES_THINK_LIMIT（字符数，默认 50000；off/0 → 关闭）。
  // v1.8.7：续跑计数按「同一轮问答」归零 ——
  //   真实用户输入（source 为 "interactive" 等非 extension）→ 本轮计数清零；
  //   硬闸自己发的续跑消息走 sendUserMessage → prompt(source: "extension")
  //   （agent-session.js:1838）与真人输入同走 input 事件，故必须靠 source 区分，
  //   否则自动续跑会把计数清零 → 死循环防护失效。
  pi.on("input", async (event: any) => {
    try {
      if (event?.source === "extension") return;
      thinkGuardRoundHits = 0;
    } catch {
      /* 不阻断输入 */
    }
  });

  pi.on("message_update", async (event: any, ctx: any) => {
    try {
      if (mode === "off") return;
      const limit = thinkLimit();
      if (!limit) return;
      const ev = event?.assistantMessageEvent;
      if (!ev) return;
      // 计数口径（2026-10-05 用户指定）：两次工具调用之间的单次思考总量。
      // 只在 LLM 调用边界重置 —— start（新一轮调用开始）/ done / error。
      // 不再按 thinking_start 重置：一次调用内若产生多个 thinking 块，应累加而非各自清零。
      // 原先用 thinking_start 重置是为防「provider 不发 thinking_start 致 armed 残留」，
      // 现由 start/done/error 兜底，残留风险更低。
      // 诊断（2026-10-05）：记录本轮见过的所有 assistantMessageEvent 类型。
      // 用途：确认当前 provider 究竟发不发 thinking_* —— 若只有 text_*，说明硬闸收不到思考事件。
      thinkDeltaTypes[ev.type] = (thinkDeltaTypes[ev.type] || 0) + 1;
      // 重置边界（v1.8.3 修正）：本 provider（ali/deepseek-v4.1-flash）**不发** start/done/error，
      // 原先只挂这三个 → 计数器跨多轮累加（实测：中断时消息自身 thinking 仅 2329 字，
      // 而计数器已到 10004）。改以 thinking_start 为主重置点：它每轮必发，且实测每条
      // assistant 消息只含一个 thinking 块，故“每轮一重置”与“两次工具调用之间的思考总量”等价。
      if (ev.type === "start" || ev.type === "done" || ev.type === "error" || ev.type === "thinking_start") {
        // 写 stats 的时机：thinking_start 时记录上一轮累计值；其余边界记录本轮累计值。
        if (ev.type !== "thinking_start" || thinkStreamChars > 0) {
          if (Object.keys(thinkDeltaTypes).length) {
            await log({
              t: new Date().toISOString(),
              event: "think_delta_stats",
              level: "info",
              at: "message_update",
              version: VERSION,
              mode,
              chars: thinkStreamChars,
              limit,
              boundary: ev.type,
              types: thinkDeltaTypes,
            });
          }
        }
        thinkDeltaTypes = {};
        thinkStreamChars = 0;
        thinkGuardArmed = false;
        return;
      }
      // 计数口径（v1.8.2 修正）：优先 thinking_delta 累加；若 provider 不发 delta
      // （一次性给完整思考内容），则在 thinking_end 用 content.length 兜底
      // （pi-ai/dist/types.d.ts:586 thinking_delta / :591 thinking_end）。
      if (ev.type === "thinking_delta") {
        thinkStreamChars += typeof ev.delta === "string" ? ev.delta.length : 0;
      } else if (ev.type === "thinking_end") {
        const full = typeof ev.content === "string" ? ev.content.length : 0;
        if (full > thinkStreamChars) thinkStreamChars = full;
      } else {
        return;
      }
      if (thinkGuardArmed || thinkStreamChars <= limit) return;
      thinkGuardArmed = true;
      thinkGuardHits++;
      lastThinkGuardNote = `单次思考 ${thinkStreamChars} 字 > 阈值 ${limit} 字，已中断`;
      await log({
        t: new Date().toISOString(),
        event: "think_guard",
        level: "warn",
        at: "message_update",
        version: VERSION,
        mode,
        chars: thinkStreamChars,
        limit,
        aborted: true,
      });
      selfAbortAt = Date.now(); // v1.8.8：先打标，再 abort —— 供 agent_settled 区分调用者
      try {
        ctx?.abort?.();
      } catch {
        /* abort 失败不影响流 */
      }
      // v1.8.5（用户 2026-10-05 修正）：deliverAs 必须是 "steer"，**不能**是 "followUp"。
      // 依据 agent-session.js:1645-1661 —— steer 在「当前 assistant turn 的工具调用执行完后、
      // 下一次 LLM 调用前」送达；followUp 则要等「agent 没有任何更多工具调用」。而 abort 只终止了
      // 当前这次 LLM 调用，后续工具照跑、agent 继续循环 → followUp 永远卡在「已排队」
      // （用户实测截图：消息显示“已排队·1”，而模型还在输出 “Push 成功。现在开 PR。”）。
      // sendUserMessage 以 user 角色进入上下文（模型当指令遵守），并触发新一轮。
      // 防死循环：同一会话最多自动续跑 3 次，超出后只作普通卡片展示，不再触发新一轮。
      // 文案可用 PI_HARD_RULES_THINK_GUARD_MSG 覆盖，支持 {chars} / {limit} 占位。
      try {
        const tpl =
          (typeof process !== "undefined" && process.env?.PI_HARD_RULES_THINK_GUARD_MSG) ||
          "你的思考超过了 {limit} 字（本轮 {chars} 字），已被强制中断。请直接给出结论，不要再展开推理过程。";
        const msg = tpl
          .replace(/\{chars\}/g, String(thinkStreamChars))
          .replace(/\{limit\}/g, String(limit));
        if (thinkGuardRoundHits < 3) {
          thinkGuardRoundHits++;
          // v1.8.6（用户 2026-10-05 实测修正）：不能在此处直接发。此刻 isStreaming 仍为 true，
          // 无论 steer 还是 followUp 都只是进队列，而 abort 之后 agent 未必还有
          // 「下一次 LLM 调用」（实测：steer 也停在「已排队」）。
          // 改为挂起，等 agent 完全停止（agent_settled）后再以 user 消息发出并启动新一轮。
          pendingThinkGuardMsg = msg;
        } else {
          pi.sendMessage(
            { customType: "hard-rules-think-guard", content: msg, display: true },
            { triggerTurn: false },
          );
        }
      } catch {
        /* 提示发不出不影响中断本身 */
      }
    } catch {
      /* 绝不阻断流 */
    }
  });

  // v1.8.6：agent 完全停止后，把挂起的硬闸提示以「用户消息」发出并启动新一轮。
  // agent_settled 语义（types.d.ts:762）：「after an agent run has fully settled and
  // no automatic retry, compaction, or queued continuation will run」—— 此时 isStreaming
  // 已为 false，sendUserMessage 会直接 prompt，不再排队。
  // （agent_before_settle 走不通：它的 SessionBoundaryDraft 只有 custom / custom_message /
  //  context_edit / compaction，没有 user 角色，给不了「由用户发出」的效果。）
  pi.on("agent_settled", async (event: any) => {
    const ours = selfAbortAt > 0;
    selfAbortAt = 0;
    if (!pendingThinkGuardMsg) return;
    const m = pendingThinkGuardMsg;
    pendingThinkGuardMsg = null;
    // v1.8.8（pi 1.1.0）：event.aborted === true 表示本轮 run 被 abort 过。
    // 若这次 abort 不是我们发起的 → 是用户主动取消（Esc / 停止按钮），
    // 只把提示作为普通卡片展示，**不再 sendUserMessage 启动新一轮**，尊重「停下」的意图。
    // （我们自己 abort 的正常路径 aborted 同样为 true，靠 ours 标记放行，否则硬闸会失效。）
    if (event?.aborted && !ours) {
      try {
        pi.sendMessage(
          { customType: "hard-rules-think-guard", content: m, display: true },
          { triggerTurn: false },
        );
      } catch {
        /* 发不出不影响 */
      }
      return;
    }
    try {
      pi.sendUserMessage(m);
    } catch {
      /* 发不出不影响 */
    }
  });

  // ── 守卫本体：调用前判定 ─────────────────────────────────────────────
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      if (mode === "off") return undefined;

      const mod = await loadModule();
      if (!mod || typeof mod.decide !== "function") {
        // fail-open，但响亮：每会话记一次错误，避免「以为在拦其实没拦」
        if (rulesOk !== false) {
          rulesOk = false;
          rulesErr = rulesErr || "tool_call 时发现 rules.mjs 不可用";
          await log({
            t: new Date().toISOString(),
            event: "rules_check_failed",
            level: "error",
            at: "tool_call",
            version: VERSION,
            rulesError: rulesErr,
          });
        }
        return undefined;
      }

      const r = mod.decide({
        toolName: event?.toolName,
        input: event?.input,
        cwd: ctx?.cwd ?? process.cwd(),
        state: { monicaSkillRead, monicaSkillBlocks },
        mode,
      });
      if (!r) return undefined;

      if (r.effects && r.effects.monicaSkillRead === true) monicaSkillRead = true;
      if (r.effects && typeof r.effects.monicaSkillBlocks === "number") {
        monicaSkillBlocks = r.effects.monicaSkillBlocks;
      }

      const willBlock = r.block === true && mode === "on";
      if (willBlock) blocks++;
      else if (r.wouldBlock === true) advisories++;

      await log({
        t: new Date().toISOString(),
        mode,
        tool: String(event?.toolName ?? ""),
        tags: r.tags,
        target: r.target,
        wouldBlock: r.wouldBlock === true,
        blocked: willBlock,
        reason: r.wouldBlock ? r.reasons.join(" | ") : "",
      });

      if (mode === "advise") return undefined;
      if (r.block === true) return { block: true, reason: r.reasons.join("\n\n") };
      return undefined;
    } catch {
      return undefined; // 任何意外 → 放行，绝不让守卫变成阻塞源
    }
  });

  // ── 输出检查本体（v1.3）：一段话说完后判定 rubric ④⑤ ──────────────────
  // advise：只记日志 + 计数，绝不改输出。on：命中就「保守改写」（摘掉命中子句、保留该行其余内容，
  //   剩不下实质内容才整行删；改后仍命中 / 清空 / 动到别的行 → 整条回退原文），再替换消息。
  pi.on("message_end", async (event: any, ctx: any) => {
    try {
      if (mode === "off") return undefined; // off：完全不检查、不记录

      const msg = event?.message;
      if (!msg || msg.role !== "assistant") return undefined; // 非 assistant 不记

      const mod = await loadModule();
      if (
        !mod ||
        typeof mod.decideOutput !== "function" ||
        typeof mod.messageTextOf !== "function"
      ) {
        // fail-open 但响亮：每会话记一次 error + 计数，绝不阻断会话
        outErrors++;
        if (!outLoadErrLogged) {
          outLoadErrLogged = true;
          await log({
            t: new Date().toISOString(),
            event: "output_check",
            level: "error",
            mode,
            version: VERSION,
            hit: false,
            rules: [],
            lines: 0,
            chars: 0,
            wouldRemove: "",
            head: "",
            applied: false,
            error: "rules.mjs 缺少 decideOutput / messageTextOf 导出（已降级为不检查）",
          });
        }
        return undefined;
      }

      const text = String(mod.messageTextOf(msg) ?? "");
      // v1.7 R7：thinking 通道。messageTextOf 只取「说给用户听的话」，⑤ 因此看不到思维链本身 ——
      // 实测「好，执行」类过渡语 100% 落在 thinking 里（text 里 0 条），必须单独取。
      const think =
        typeof mod.messageThinkingOf === "function" ? String(mod.messageThinkingOf(msg) ?? "") : "";

      const r = text.trim() ? mod.decideOutput(text, { mode }) : undefined;
      // R7 可单独关：PI_HARD_RULES_THINK=off（只停 thinking 通道，不影响 ④⑤J1G1）
      const thinkOn = env("PI_HARD_RULES_THINK").trim().toLowerCase() !== "off";
      const rt =
        thinkOn && think.trim() && typeof mod.decideThinking === "function"
          ? mod.decideThinking(think)
          : undefined;
      const textHit = !!r && r.hit === true;
      const thinkHit = !!rt && rt.hit === true;
      if (!textHit && !thinkHit) return undefined; // 两条通道都未命中：不记日志（每条消息最多一条命中记录）

      outHits++;
      if (thinkHit) outThinkHits++;
      lastOutNote = [
        ...(textHit ? [String(r!.reason ?? "")] : []),
        ...(thinkHit ? ["R7 思维链复读（过渡语空转）"] : []),
      ]
        .filter(Boolean)
        .join(" + ");
      const hitRules: string[] = [...(textHit ? r!.rules : []), ...(thinkHit ? rt!.rules : [])];
      const removeLines: string[] = textHit && Array.isArray(r!.removeLines) ? r!.removeLines : [];
      const thinkLines: string[] = thinkHit && Array.isArray(rt!.removeLines) ? rt!.removeLines : [];

      // on 档 + 真改总闸打开时才替换（默认只记录）；必须保持同 role（.ts 不碰 role）
      let applied = false;
      let replaceMsg: any = undefined;
      // v1.3：清理已升级为「子句级保守改写」，顺带索取 detail 供日志审计；
      //       兼容老版 applyOutputClean 直接返回 content 的形态（拿不到 detail 就只记 applied）
      let clean: any = undefined;
      const wantsClean = removeLines.length > 0 || thinkLines.length > 0;
      if (mode === "on" && outApply && wantsClean && typeof mod.applyOutputClean === "function") {
        const out = mod.applyOutputClean(msg.content, removeLines, {
          detail: true,
          includeThinking: thinkLines.length > 0, // 只有真有 thinking 点名行才开这条通道
          thinkLines,
        });
        const isDetail = !!out && typeof out === "object" && "content" in out;
        clean = isDetail ? out : undefined;
        const next = isDetail ? out.content : out;
        applied = next !== msg.content;
        if (applied) replaceMsg = { message: { ...msg, content: next } };
      }

      await log({
        t: new Date().toISOString(),
        event: "output_check",
        mode,
        version: VERSION,
        hit: true,
        rules: hitRules,
        lines: text.split(/\r?\n/).filter((l: string) => l.trim()).length, // 非空行数（对齐 rubric ①）
        chars: text.length,
        // v1.7 R7：thinking 通道留痕（thinkLines=0 即为旧版行为）
        thinkLines: thinkLines.length,
        thinkChars: think.length,
        wouldRemove: String((textHit ? r!.wouldRemove : rt?.wouldRemove) ?? ""),
        head: (text.trim() ? text : think).slice(0, 40),
        applied,
        // v1.3：保守改写审计字段（仅在真改分支挂上；from/to 各截 200 字符，便于事后核对与回滚）
        ...(clean
          ? {
              from: String(clean.from ?? "").slice(0, 200),
              to: String(clean.to ?? "").slice(0, 200),
              // v1.7：thinking 通道的审计对
              fromThink: String(clean.fromThink ?? "").slice(0, 200),
              toThink: String(clean.toThink ?? "").slice(0, 200),
              removed: clean.removed ?? 0,
              ops: Array.isArray(clean.ops) ? clean.ops.map((o: any) => ({ rule: o.rule, dropped: o.dropped })) : [],
              skipped: clean.skipped ?? 0,
              reverted: clean.reverted === true,
              revertReason: clean.revertReason ?? null,
            }
          : {}),
      });

      return replaceMsg;
    } catch (e: any) {
      // 任何异常都吞掉 + 计数 + 留一条 error 记录（不抛给用户、不阻断会话）
      try {
        outErrors++;
        await log({
          t: new Date().toISOString(),
          event: "output_check",
          level: "error",
          mode,
          version: VERSION,
          hit: false,
          rules: [],
          lines: 0,
          chars: 0,
          wouldRemove: "",
          head: "",
          applied: false,
          error: String(e?.message ?? e),
        });
      } catch {
        /* 记日志失败也不再做任何事 */
      }
      return undefined;
    }
  });
}
