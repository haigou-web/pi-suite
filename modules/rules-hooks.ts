// rules-hooks.ts — pi 扩展：把 AGENTS.md 里「能机械判定」的规则做成钩子。
// 与 hard-rules.ts（1.6）相互独立：不 import、不改它的状态，出问题直接删本文件即可恢复原状。
//
// 开关（env）：
//   PI_RULES_HOOKS=off     → 整体停用（不拦不记）
//   PI_RULES_HOOKS=advise  → 全部只记录，不拦
//   缺省 on                → H9 / H11 真拦，其余只记
// 状态：/rules-hooks      日志：<PI_AGENT_DIR>/logs/rules-hooks.jsonl（可用 PI_RULES_HOOKS_LOG 覆盖）
//
// 规则映射：
//   H9a 生图命令必须显式 -Model 'GPT Image 2.5 Flare'             → block
//   H9b 真跑前须先跑一次不带 -ClickConfirm 的配置轮               → block
//   H11 Jev 不用于算术连动 / 合计行 / 数值核验                     → block
//   H4  实现术语首次出现要附一句人话解释                           → advise
//   H5  不预演未要求步骤                                           → advise
//   H6  估不准就说「不确定」，不编数字                             → advise
//   H8  文档读取要给 OUT / CHARS / headings 回执                   → advise

import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");

const VERSION = "rules-hooks/1.1";
const LOG_PATH = process.env.PI_RULES_HOOKS_LOG || path.join(LOG_DIR, "rules-hooks.jsonl");

// 术语表：命中且该行没有解释标记 → H4
const JARGON = [
  "钩子", "注入", "持久化", "拆箱", "fail-open", "fail-closed", "幂等", "回滚", "句柄",
  "回调", "中间件", "符号表", "闭包", "竞态", "脏读", "熔断", "降级", "灰度", "序列化",
  "反序列化", "反代", "桩", "打桩", "影子表", "双写",
];
// 解释标记：出现任一即视为「附了人话」
const GLOSS = ["（", "(", "「", "——", "即", "也就是", "意思是", "指的是", "通俗", "换句话", "翻译成", "等于", "="];
// 不确定词 / 来源标记：出现任一即不判 H6
const HEDGE = ["不确定", "大概", "约", "估", "可能", "待核", "据", "实测", "来源", "http", "\\", "/"];
const JEVI = /jev-latest|systemone|type[-_ ]?safe|jev[-_ ]?(judge|score|ask)/i;
const ARITH = /合计|求和|加总|总数|累加|核对数字|核验数值|重算|校验算术|算术校验|数字对不对/;

type Mode = "on" | "advise" | "off";
const MODES: Mode[] = ["on", "advise", "off"];

export default function (pi: any) {
  const counters: Record<string, number> = {};
  let lastNote = "";
  let fsMod: any = null;
  let monicaConfigRun = false; // 本会话是否已跑过「不带 -ClickConfirm」的配置轮
  let docReadSeen = false; // 本会话是否跑过 doc-read 的 to-md.ps1

  function mode(): Mode {
    const v = String(process.env.PI_RULES_HOOKS ?? "").trim().toLowerCase();
    return v === "off" ? "off" : v === "advise" ? "advise" : "on";
  }

  async function getFs(): Promise<any> {
    try {
      if (!fsMod) fsMod = await import("node:fs");
    } catch {
      /* 拿不到 fs 就只计数，不写日志 */
    }
    return fsMod;
  }

  async function logLine(id: string, info: Record<string, any>): Promise<void> {
    try {
      const fs = await getFs();
      if (!fs) return;
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(
        LOG_PATH,
        JSON.stringify({ t: new Date().toISOString(), version: VERSION, hook: id, mode: mode(), ...info }) + "\n",
      );
    } catch {
      /* 日志失败不影响判定 */
    }
  }

  function bump(id: string, info: Record<string, any> = {}): void {
    counters[id] = (counters[id] ?? 0) + 1;
    lastNote = `${id} · ${new Date().toLocaleTimeString()} · ${String(info.target ?? "").slice(0, 60)}`;
    void logLine(id, info);
  }

  function shellCmd(input: any): string {
    const c = input?.command;
    return typeof c === "string" ? c : "";
  }

  function messageText(msg: any): string {
    const c = msg?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .join("\n");
    }
    return "";
  }

  // ── 守卫：工具调用前 ────────────────────────────────────────────────
  try {
    pi.on("tool_call", async (event: any, ctx: any) => {
      try {
        const m = mode();
        if (m === "off") return undefined;
        const tool = String(event?.toolName ?? "");
        const cmd = shellCmd(event?.input);

        // 2026-09-23 删掉 H7（「子 Agent 一律走 acp_delegate」）：用户已关掉 pi-web 默认子代理，
        // Agent / TaskExecute 不再出现在派活路径上，这条守卫没有对象了（版本 1.0 → 1.1）。

        // 内联执行（有 command）时，才判 Jev 相关规则；避免误伤子代理调用的 task 文本
        if (cmd) {
          // H11：Jev 相关
          if (JEVI.test(cmd)) {
            if (ARITH.test(cmd)) {
              bump("H11", { target: cmd, tool });
              if (m === "on") {
                return {
                  block: true,
                  reason:
                    "本机规则（AGENTS.md §9）：Jev 不可用于算术连动 / 合计行 / 数值核验（实测 50%，等于掷硬币）。\n" +
                    "改用脚本重算：把原始数据交给 node / py -3 求和核对，不要问模型。",
                };
              }
              return undefined;
            }
          }

          // H9：生图
          if (/monica/i.test(cmd)) {
            if (!/GPT Image 2\.5 Flare/i.test(cmd)) {
              bump("H9a", { target: cmd, tool });
              if (m === "on") {
                return {
                  block: true,
                  reason:
                    "本机规则（AGENTS.md §8）：生图命令必须显式带 -Model 'GPT Image 2.5 Flare'。\n" +
                    "硬要求全文见 monica-ai-workflow 技能的 SKILL.md §B。",
                };
              }
              return undefined;
            }
            const hasClick = /-ClickConfirm/i.test(cmd);
            if (hasClick && !monicaConfigRun) {
              bump("H9b", { target: cmd, tool });
              if (m === "on") {
                return {
                  block: true,
                  reason:
                    "本机规则（AGENTS.md §8）：真跑前先跑一次**不带 -ClickConfirm** 的配置轮，核对模型 / 比例 / 画质；\n" +
                    "确认无误后再带 -ClickConfirm 真跑。",
                };
              }
              return undefined;
            }
            if (!hasClick) monicaConfigRun = true; // 记下：本会话已跑过配置轮
          }

          // 记录：本会话跑过 doc-read 的转换脚本（供 H8 用）
          if (/to-md\.ps1/i.test(cmd)) docReadSeen = true;
        }
        return undefined;
      } catch {
        return undefined; // 任何意外一律放行，绝不让守卫变成阻塞源
      }
    });
  } catch {
    /* 注册失败不影响 pi 启动 */
  }

  // ── 检查：一段话说完后（只记不改）────────────────────────────────────
  try {
    pi.on("message_end", async (event: any, _ctx: any) => {
      try {
        const m = mode();
        if (m === "off") return undefined;
        const msg = event?.message;
        if (!msg || msg.role !== "assistant") return undefined;
        const text = messageText(msg);
        if (!text.trim()) return undefined;
        const lines = text.split(/\r?\n/);

        // H4：术语没解释
        for (const line of lines) {
          const hit = JARGON.find((j) => line.includes(j));
          if (!hit) continue;
          if (GLOSS.some((g) => line.includes(g))) continue;
          bump("H4", { target: line.slice(0, 80), term: hit });
          break; // 每条消息最多记一次，避免刷屏
        }

        // H5：预演未要求步骤
        if (/接下来我(会|将|先)|我打算先|我的计划是|我的步骤是|首先我会/.test(text)) {
          bump("H5", { target: (text.match(/接下来我(会|将|先)|我打算先|我的计划是|我的步骤是|首先我会/) ?? [""])[0] });
        }

        // H6：精确数字无来源无不确定词
        for (const line of lines) {
          if (!/\d+(\.\d+)?\s*(%|％|分钟|小时|秒|次|条|个|字节|KB|MB|GB|元|ms)/.test(line)) continue;
          if (HEDGE.some((h) => line.includes(h))) continue;
          bump("H6", { target: line.slice(0, 80) });
          break;
        }

        // H8：跑过转换脚本但没给回执
        if (docReadSeen && !(/OUT/.test(text) && /CHARS/.test(text) && /headings/i.test(text))) {
          bump("H8", { target: "缺少 OUT / CHARS / headings 回执" });
        }
        return undefined;
      } catch {
        return undefined;
      }
    });
  } catch {
    /* 注册失败不影响 pi 启动 */
  }

  // ── 会话切换时重置会话内状态 ───────────────────────────────────────
  try {
    pi.on("session_start", async () => {
      monicaConfigRun = false;
      docReadSeen = false;
    });
  } catch {
    /* 忽略 */
  }

  // ── /rules-hooks：看状态 ───────────────────────────────────────────
  try {
    pi.registerCommand("rules-hooks", {
      description: "新钩子状态：命中计数与开关",
      getArgumentCompletions: (prefix: string) => {
        try {
          const items = MODES.filter((v) => v.startsWith(String(prefix ?? "")));
          return items.length ? items.map((v) => ({ value: v, label: v })) : null;
        } catch {
          return null;
        }
      },
      handler: async (_args: any, ctx: any) => {
        try {
          const m = mode();
          const rows = [
            "H9a 生图缺 -Model 'GPT Image 2.5'  " + (counters.H9a ?? 0),
            "H9b 生图跳过了配置轮               " + (counters.H9b ?? 0),
            "H11 Jev 用于算术/合计              " + (counters.H11 ?? 0),
            "H4  术语没解释（只记录）           " + (counters.H4 ?? 0),
            "H5  预演未要求步骤（只记录）       " + (counters.H5 ?? 0),
            "H6  数字没来源（只记录）           " + (counters.H6 ?? 0),
            "H8  文档读取没给回执（只记录）     " + (counters.H8 ?? 0),
          ];
          const out = [
            `扩展 ${VERSION} ｜ 模式：${m}${m === "advise" ? "（只记录不拦）" : ""}`,
            "本会话命中：",
            ...rows,
            `monica 配置轮：${monicaConfigRun ? "已跑" : "未跑"}｜doc-read 转换：${docReadSeen ? "跑过" : "没跑过"}`,
            lastNote ? `最近一次：${lastNote}` : "最近一次：无",
            `日志：${LOG_PATH}`,
            "开关：env PI_RULES_HOOKS=off|advise（off 全停 / advise 只记不拦）",
          ].join("\n");
          if (ctx?.ui?.setStatus) ctx.ui.setStatus("rules-hooks", `${VERSION} ${m} hit=${Object.values(counters).reduce((a, b) => a + b, 0)}`);
          return out;
        } catch (e: any) {
          return `状态输出失败：${String(e?.message ?? e)}`;
        }
      },
    });
  } catch {
    /* 注册命令失败不影响守卫 */
  }
}
