// multistep-gate.ts — pi 扩展：多步判定 + 提示词注入
//
// 2026-10-07：随 @tintinweb/pi-tasks 移除，任务面板对账（tasks-reconcile.mjs）整块删除。
// 2026-09-23 大删减（用户决定）：只保留「判定 + 贴规则」两件事。
//   删掉的：步号 k/n 的记账与推进、首行锚点解析与代写、steps.mjs 模块、「已完成」计数、
//   进行中任务的过期（PI_MULTISTEP_TASK_MAX_IDLE / TASK_IDLE_MS / AUTO_ANCHOR 三个开关一并作废）。
//   起因：插件替模型记账，结果任务早就做完了还报「第 7 步」、单步请求也被挂上多步协议。
//   现在「多步」只是提示词约束：判 multi 就把规则写进系统提示；是否需要多步、分几步、怎么编号，
//   全部由模型自己判断和维护，插件不再过问、不再统计、不再改写回复。
//
// 做什么：
//   ① before_agent_start：拿本轮用户原文 + 上一轮用户消息 → 调 judge（正则兜底优先，否则 jev-latest）
//      → cls === "multi" 写入「多步协议」块（首行列步骤清单、模型自己维护 [第k/n步]、一条回复只做一步）；
//        cls === "single"（且判定没报错）时写入「单步判定」块（直接给结论、跳过拆解/罗列/自我确认）。
//      两段文案都是用户指定的原文，改字只改 injectMessage / injectSingleMessage 这两个函数。
//      写入位置（2026-09-23 深夜改版）＝ 用户侧一条 custom 消息（customType=multistep-verdict）：
//        · 旧版写系统提示的 XML section，但系统块位于请求最前面，这段文本每轮都在变（p / 来源）⇒
//          整段对话的缓存前缀全废（实测 cached 只剩 2.9K / 输入 75K，等于全 miss）。
//        · 现在恒定规则（两条模板原文）放全局 AGENTS.md（恒定 ⇒ 永不破缓存），每轮只把
//          「本轮判定」那一两行贴到对话尾部：前缀纹丝不动，只多算它自己的 token，
//          下一轮起这行也固化进前缀。
//        · 2026-09-26 再换通道：不再用 pi.sendMessage（deliverAs:"steer" 会塞进当前轮的
//          steering 队列、逼界面在轮中重绘一次 ⇒ 用户消息被画两遍、隐藏卡片露出来），改为
//          before_agent_start 的返回值 { message: {…} }（types.d.ts:917）：进的是本轮消息数组、
//          对话启动前就绪、不落盘。口子见下方 before_agent_start 末尾的 return { message: … }。
//      ⚠️ 老版本留在 transcript 里的 section 补丁要显式删一次（clearProtocolSection）；
//         删空之后再调用是 no-op —— 不产生补丁、不破缓存，所以每轮都调是安全的。
//   ② 日志：判定与注入结果在当轮就落 jsonl（id = judge-<序号>），字段含 cls / pMulti / source /
//      regex / injected / th / ms / in_tok / out_tok / error。2026-09-23 起删掉 message_end 钩子，
//      因为已经没有需要解析或改写的东西了。
//
// 逻辑本体：./multistep-gate/judge.mjs（判定，纯函数可单测）。
// 判定数据依据：30 例真实样本标定（2026-09-21 ~ 09-23）。当前默认 τ=0.40（2026-09-23 晚定）：90.0% 准确 / prec 92.3% / recall 85.7%。
//
// ⚠️ 红线：
//   · 模块加载期 / factory 体内只声明，不做任何可能抛错的事（pi 在加载期报错会直接 exit 1）。
//   · judge.mjs 延迟到首次使用时才动态 import，失败即降级放行（不注入、不拦）。
//   · 「判成 single」（含失败/超时）绝不作为跳过检查的依据，只使用「判成 multi」这个方向。
//
// 开关（env）：
//   PI_MULTISTEP=off           → 完全停用（不判定、不注入、不记日志）
//   PI_MULTISTEP_THRESHOLD     → 判 multi 的 p 阈值，默认 0.40
//   PI_MULTISTEP_TIMEOUT_MS    → 单次 Jev 请求超时，默认 3000
//   PI_MULTISTEP_BUDGET_MS     → 含重试的总预算，默认 timeoutMs*3
//   PI_MULTISTEP_SINGLE=off    → 判为单步时不注入「单步判定」块（只记录，不改回复）
//   PI_MULTISTEP_SHOW=0        → 判定卡片不在界面上显示；默认显示（2026-09-26 起），便于确认判定真的执行了
//   PI_MULTISTEP_LOG           → 日志路径，默认 <PI_AGENT_DIR>/logs/multistep-gate.jsonl
//   PI_MULTISTEP_KEY_FILE      → 覆盖 key 文件路径，默认 <PI_AGENT_DIR>/.typesafe_key.txt（仅供测试）
//   PI_MULTISTEP_ENDPOINT      → 覆盖 Jev 端点（仅供测试：e2e 起本地假服务）
//   PI_MULTISTEP_VIA           → 判定走哪条通道：auto（默认，先官方 registry 后 HTTP 兜底）/ http（只用老路子）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");

const DEFAULT_LOG = process.env.PI_MULTISTEP_LOG || path.join(LOG_DIR, "multistep-gate.jsonl");
// 协议块在系统提示里的 section 名（XML tag）。多步/单步两套文案共用它 —— 同一个 tag 才能被定点替换。
const PROTOCOL_TAG = "multistep-protocol"; // 旧版用的系统提示 section（现只用于清残留）
const VERDICT_TAG = "multistep-verdict"; // 本轮判定写在用户侧的 custom 消息 customType
// 判定文本是否在界面上显示成卡片（默认显示；PI_MULTISTEP_SHOW=0 关）。
// ⚠️ display 只影响界面渲染：发给模型的内容、落盘记录、缓存前缀都与它无关。
const SHOW_VERDICT = process.env.PI_MULTISTEP_SHOW !== "0";
const DEFAULT_KEY_FILE = process.env.PI_MULTISTEP_KEY_FILE || path.join(AGENT_DIR, ".typesafe_key.txt");
const DEFAULT_THRESHOLD = 0.40; // 2026-09-23 晚 由 0.30 回到 0.40（用户指令「将二者的阈值改为 “0.4” 而不是 “0.3”」）：两档准确率同为 90.0%，0.40 换得 precision 92.3%（少把单步轮判成多步），代价是 recall 85.7%、30 例里漏判 2 条真多步；0.30 那档 recall 100%（漏判 0）但单步轮被误判率更高。标定数据见 长期保留/Jev多步判定-实测.md；可用 PI_MULTISTEP_THRESHOLD 临时覆盖
const DEFAULT_TIMEOUT_MS = 3000;

type JudgeResult = {
  cls: "multi" | "single";
  pMulti: number | null;
  source: "regex" | "jev";
  via?: "regex" | "registry" | "http"; // 实际走的通道（2026-10-03 双通道起；老结果没这个字段）
  choice: string | null;
  regex?: string;
  ms: number;
  inTok: number;
  outTok: number;
  error?: string;
};

type JudgeFn = (opts: {
  prompt: string;
  context?: string;
  timeoutMs?: number;
  threshold?: number;
  budgetMs?: number;
  keyFile?: string;
  registry?: any; // 传了就走 pi 官方分类器通道（ctx.modelRegistry.classify）
}) => Promise<JudgeResult>;

function env(name: string): string {
  try {
    return String(process.env[name] ?? "");
  } catch {
    return "";
  }
}
function envNum(name: string, dflt: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---- 动态 import：首次使用时才加载，失败降级为「不判定」，绝不让它变成 pi 启动失败 ----
let modPromise: Promise<any | null> | null = null;
function loadModule(): Promise<any | null> {
  try {
    if (!modPromise) modPromise = import("./multistep-gate/judge.mjs").catch(() => null);
    return modPromise;
  } catch {
    return Promise.resolve(null);
  }
}
function loadJudge(): Promise<JudgeFn | null> {
  return loadModule().then((m: any) =>
    typeof m?.judge === "function" ? (m.judge as JudgeFn) : null,
  );
}

// ---- 官方通道的 key 桥接 ------------------------------------------------------
// pi 内置的 typesafe provider 只认环境变量 TYPESAFE_API_KEY（或 /login typesafe 存的凭据）。
// 我们历史上把 key 放文件里，为了不逼用户改习惯：首次需要时把文件内容补进 process.env。
// 只在环境变量为空时补一次；不打印、不落日志。
let envKeyBridged = false;
function ensureTypesafeEnvKey(keyFile: string): void {
  try {
    if (envKeyBridged) return;
    envKeyBridged = true;
    if (env("TYPESAFE_API_KEY").trim()) return; // 已经设了就不动（/login 存的凭据优先级更高，pi 自己会取）
    const k = fs.readFileSync(keyFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (k) process.env.TYPESAFE_API_KEY = k;
  } catch {
    /* 读不到就算了：官方通道会失败并自动回退到 HTTP */
  }
}

// ---- 日志（只写不改；目录不存在就建；任何失败都吞掉） ----
function logPath(): string {
  try {
    const p = env("PI_MULTISTEP_LOG").trim();
    return p || DEFAULT_LOG;
  } catch {
    return DEFAULT_LOG;
  }
}
function appendLog(rec: Record<string, unknown>): void {
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    /* 记日志失败不影响主流程 */
  }
}

function firstLine(text: string): string {
  try {
    return String(text || "").split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  let lastUserPrompt = ""; // 上一轮用户原文 → 作为 judge 的 recent_context

  let seq = 0;

  // ---- 协议块的注入口子：before_agent_start 的返回值（2026-09-26 改）----
  // 旧写法是 pi.sendMessage(..., {deliverAs:"steer"})：消息进的是「当前这一轮的 steering 队列」，
  // 界面必须在轮中插一条 → 触发一次重绘，表现为「我发的一条消息显示两遍 + 隐藏卡片露出来」。
  // 改用官方给扩展留的返回值通道（types.d.ts:917 BeforeAgentStartEventResult.message）：
  // runner.js:1040 收集 → agent-session.js:1307 拼进本轮消息数组 → _runAgentPrompt(messages)，
  // 在对话启动前就绪、不经 steering 队列 ⇒ 不触发轮中重绘；也不落盘（会话文件里不再多这一条）。
  // 投影到 LLM 时仍是 role:"user" + 文本原样，位置在对话尾部 ⇒ 不碰请求前缀，缓存不破。
  // 用法：在 before_agent_start 里把文本攒进 verdictText，末尾 return { message: {...} }。

  // 迁移用（2026-09-23 晚）：旧版把协议写进系统提示的 section，那些补丁还留在 transcript 里。
  // 显式删一次让 pi 发一条「清空」补丁；删空后再调用不产生任何差异 ⇒ 每轮调用也安全。
  function clearProtocolSection(event: any): void {
    try {
      const opts = event?.systemPromptOptions;
      if (opts && opts.sections && typeof opts.sections === "object") delete opts.sections[PROTOCOL_TAG];
    } catch {
      /* 同上 */
    }
  }

  // 返回「本轮判定」那一两行文本，由 before_agent_start 的返回值送到本轮请求尾部（2026-09-26 改）。

  // 多步协议：用户指定的原文（2026-09-23 换版；2026-09-24 精简版：n 行去掉「每条回复」、
  // 删掉「每条回复只聚焦当前这一步…不视为停顿」与「禁止在同一条回复里提前完成…」两条，
  // 完成标记收成一句「第k步实际执行完成后…」，后两条边界各并成一行）。
  // 2026-09-24 再加一条边界：「全程使用中文思维链」——用户实测英文思路写作带偏了思考语言。
  // 2026-09-24 晚已回滚：紧凑版（去空行 + n 行「暂停后重启」）经用户要求撤回，恢复为下面这版带分段的格式。
  // 插件只填 p 与来源；步骤清单、n 的估算、每条回复的 [第 k/n 步] 全由模型自己维护，插件不再解析也不再改写。
  // 注：代码里没有任何步数上限，「≤5」原本只是文案约束，去掉后无需改逻辑。
  // 正文直接写在注入消息里（2026-09-23 定）：不放 AGENTS.md——那样既不强制（模型可能不照做），又要多花一轮去查。
  const MULTI_BODY =
    "请在首行列出完整步骤清单，格式如下：\n" +
    "「[第1/n步] 步骤总览：① ... ② ... ③ ...」\n" +
    "（n为你评估的总步数，此后首行标注当前所处的 [第k/n步]）\n" +
    "\n" +
    "执行边界（不可跳过）：\n" +
    "· 全程使用中文思维链，推理过程用中文\n" +
    "· 第k步实际执行完成后，把完成标记并进首行锚点——写成「[第k/n步 · 已完成]」\n" +
    "· 若执行过程中出现意外情况（如低估任务难度、任务范围超出预期等），立即停止执行，向用户说明情况，并重新估算、声明新的总步数\n" +
    "· 只有以下情况才允许暂停等待用户：① 需要用户提供信息、决策或授权才能继续；② 全部计划步骤已完成；③ 步骤范围仍需澄清";

  const SINGLE_BODY =
    "请直接给出结论或答案，跳过任务拆解、方案罗列、多轮自我确认等中间过程；如内容确需分点，直接用最简结构呈现即可，不必解释拆分理由。\n" +
    "\n" +
    "只有当问题本身存在明显歧义、缺少必要信息、或直接回答会导致误导时，才追加一句简短澄清或前提说明——否则不要主动追加背景铺垫、免责声明或\"是否需要进一步说明\"之类的收尾。\n" +
    "\n" +
    "全程使用中文思维链，推理过程用中文。";

  // 来源标签（2026-10-09 加）：judge.mjs 的 source 只有 "regex"（本地正则规则，不联网）与
  // "jev"（TypeSafe 云端概率）两种。此前多步文案把来源硬编码成 "Jev p="，正则命中的结果
  // 也被标成 Jev，误导排查（用户 2026-10-09 指出「为啥我有的会话窗口是可以用的」时暴露）。
  function srcLabel(source: string): string {
    if (source === "regex") return "本地正则";
    if (source === "jev") return "Jev";
    return source || "未知";
  }

  function injectMessage(r: JudgeResult): string {
    const p = r.pMulti === null || !Number.isFinite(r.pMulti) ? "n/a" : r.pMulti.toFixed(2);
    const head = "[多步判定] 本轮任务需要分步执行（" + srcLabel(r.source) + " p=" + p + "）。";
    return head + "\n\n" + MULTI_BODY;
  }

  function injectSingleMessage(r: JudgeResult): string {
    // 文案由用户指定（2026-09-23）：判为单步时用这段，压住「拆解 / 罗列 / 自我确认」那套中间过程。
    const p = r.pMulti === null || !Number.isFinite(r.pMulti) ? "n/a" : r.pMulti.toFixed(2);
    const head = "[单步判定] 触发来源 " + srcLabel(r.source) + "，置信度 " + p + "。";
    return head + "\n\n" + SINGLE_BODY;
  }

  // ---- ① 判定 + 注入（multi → 多步协议；single → 直接给结论）----
  // 插件只决定「贴哪段规则」。多步任务的状态（第几步、总共几步、做没做完）不再由插件维护。
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (env("PI_MULTISTEP") === "off") {
        clearProtocolSection(event); // 停用时不留残留：section 是持续状态，不像消息那样一次性
        return undefined;
      }

      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const prevPrompt = lastUserPrompt;
      if (!prompt.trim() || prompt.trimStart().startsWith("/")) return undefined;

      const judgeFn = await loadJudge();
      if (!judgeFn) return undefined; // 模块加载失败 → 降级放行

      const threshold = envNum("PI_MULTISTEP_THRESHOLD", DEFAULT_THRESHOLD);
      const timeoutMs = envNum("PI_MULTISTEP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
      const budgetMs = envNum("PI_MULTISTEP_BUDGET_MS", timeoutMs * 3);
      const keyFile = env("PI_MULTISTEP_KEY_FILE").trim() || DEFAULT_KEY_FILE;
      const endpoint = env("PI_MULTISTEP_ENDPOINT").trim(); // 仅供测试（e2e 起本地假 Jev 服务）
      const viaMode = env("PI_MULTISTEP_VIA").trim().toLowerCase() || "auto";

      // 官方通道：把 key 桥进 TYPESAFE_API_KEY（pi 的 typesafe provider 只认它），再把 ctx.modelRegistry 交给 judge。
      // 拿不到 registry（老版 pi / 非扩展环境）或官方通道报错时，judge 内部会自动回退到 HTTP —— 不会比改前更差。
      let registry: any = null;
      if (viaMode !== "http") {
        ensureTypesafeEnvKey(keyFile);
        registry = (ctx as any)?.modelRegistry ?? null;
      }

      const r = await judgeFn({
        prompt,
        context: prevPrompt,
        timeoutMs,
        threshold,
        budgetMs,
        keyFile,
        ...(endpoint ? { endpoint } : {}),
        ...(registry ? { registry } : {}),
      });
      lastUserPrompt = prompt;
      if (!r) return undefined; // 判定失败/超时 → 不注入，也无结果可记

      // 迁移收尾：把老版本写进系统提示的 section 补丁清掉（删空后再调用是 no-op，不破缓存）。
      clearProtocolSection(event);
      // multi → 多步模板；single → 单步模板。两者都只把「本轮判定」那一两行贴到用户侧尾部。
      const wantSingle = env("PI_MULTISTEP_SINGLE") !== "off" && !r.error;
      let injected: boolean;
      let verdictText: string | null = null;
      if (r.cls === "multi") {
        injected = true;
        verdictText = injectMessage(r);
      } else if (wantSingle) {
        injected = true;
        verdictText = injectSingleMessage(r);
      } else {
        injected = false;
      }

      appendLog({
        id: "judge-" + ++seq,
        ts: new Date().toISOString(),
        prompt: firstLine(prompt).slice(0, 120),
        cls: r.cls,
        pMulti: Number.isFinite(r.pMulti as number) ? r.pMulti : null,
        source: r.source,
        via: (r as any)?.via ?? null,
        regex: r.regex ?? null,
        judged: true,
        injected,
        th: threshold,
        choice: (r as any)?.choice ?? null,
        attempts: typeof (r as any)?.attempts === "number" ? (r as any).attempts : null,
        ms: r.ms,
        in_tok: r.inTok,
        out_tok: r.outTok,
        ...(r.error ? { error: r.error } : {}),
      });
      // 判定文本随本轮请求交给 pi：走 before_agent_start 的返回值通道（不落盘、不动界面）。
      return verdictText
        ? { message: { customType: VERDICT_TAG, content: verdictText, display: SHOW_VERDICT } }
        : undefined;
    } catch {
      return undefined;
    }
  });

  // ---- 会话切换：清掉上一会话的残留（上一轮用户原文）----
  pi.on("session_start", async (_event: any, _ctx: any) => {
    try {
      lastUserPrompt = "";
    } catch {
      /* ignore */
    }
    return undefined;
  });
}