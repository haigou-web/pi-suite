// judge.mjs — 「本轮是多步任务还是单答」判定器（正则兜底 + Jev）
//
// 逻辑：① 正则先兜底（@引用 / 「第 N 项」/ 继续-同上 等「动作不在本条消息里」的信号），命中即判 multi，
//        不发任何网络请求；② 否则调 jev-latest 单题 choice，p(多步任务) ≥ threshold 判 multi。
//
// 通道（2026-10-03 起双通道；结果里的 via 字段标明走了哪条）：
//   ① "registry" —— 调用方传了 opts.registry（= pi 的 ctx.modelRegistry）时优先走**官方通道**
//      registry.classify()：key 交给 pi 的 provider 认证层统一解析（环境变量 TYPESAFE_API_KEY 或
//      /login typesafe 存的凭据）、自带重试（maxRetries 默认 2）与超时，usage 进 pi 的会话统计。
//   ② "http" —— 老路子：自己读 key 文件 + fetch 直打 https://api.typesafe.ai/v1/systemone。
//      该端点与官方目录 data/typesafe.json 里的 baseUrl 逐字一致（2026-10-03 实测同一服务、同一协议），
//      所以两条通道等价；registry 不可用 / 报错时静默回退到它，**绝不比原来更容易失败**。
//   ⚠️ 官方 classify() **从不抛异常**：失败只体现为 stopReason:"error"+errorMessage，故不能靠 try/catch 判成败。
//   两条通道都失败 → 照旧降级放行（返回 cls:"single" + error，不注入、不拦）。
//
// 调用写法（端点 / 退避表 / usage 读取）参照已验证实现。
// 实测（30 条真实样本）：86.7% 总体 / τ=0.40 时 90.0%、prec 92.3%、recall 85.7%、
// 平均 433ms、649 in + 37 out token。已知局限：靠 @文件 /「第 3 项」/ 上下文指代的样本会漏判 → 由正则兜底。
//
// ⚠️ 只用「判成 multi」这个方向：cls==="single"（含失败/超时）不得作为跳过检查的依据。
//
// key：只从下面这两个来源读，全程不打印、不写日志：
//   ① 文件 <PI_AGENT_DIR>/.typesafe_key.txt（首选，可被 PI_MULTISTEP_KEY_FILE 覆盖）
//   ② 环境变量 TYPESAFE_API_KEY（兜底）
// 参数（config 由调用方传入，environment 见 multistep-gate.ts 文件头）：
//   prompt    本轮用户原文（必填）
//   context   上一轮用户消息（可选，作为 recent_context）
//   timeoutMs 单次请求超时，默认 3000
//   threshold p(多步任务) 判定阈值，默认 0.40（2026-09-23 晚由 0.30 上调，理由见 multistep-gate.ts 的 DEFAULT_THRESHOLD 注释）
//   budgetMs  重试总预算，默认 timeoutMs*3（受它约束，退避等待 + 下一次超时必须放得下才重试）
//   keyFile   覆盖 key 文件路径（仅测试用）
//   endpoint  覆盖端点（仅测试用）
//   fetchImpl 覆盖 fetch（仅测试用）
//
// 返回：{ cls:"multi"|"single", pMulti, source:"regex"|"jev", choice, ms, inTok, outTok, error? }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const DEFAULTS = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  keyFile: path.join(AGENT_DIR, ".typesafe_key.txt"),
  timeoutMs: 3000,
  threshold: 0.40,
  retryWaitsMs: [3000, 10000, 25000, 45000],
};

const CAND_MULTI = "多步任务";
const CAND_SINGLE = "单答";

const INSTRUCTIONS =
  "这条用户消息要求的是「需要多步执行、有中间状态、不是一次回答就能交付」的任务，还是一次问答即可交付？";

// 与实测实验完全一致的 criteria 文本（不含 Jev / TypeSafe 字样）
const CRITERIA = {
  [CAND_MULTI]:
    "要求助手动手做一件事，且必须分多步执行、过程中存在中间状态（要改多个文件 / 要跑多步流程 / 要反复迭代或逐项处理），无法只用一次回答交付。",
  [CAND_SINGLE]:
    "只是问一个事实、要一个解释、要一个判断、要一个对比结论或一份说明，一次回答就能交付，不需要分步动手改动。",
};

// ---- 正则兜底 ---------------------------------------------------------------
// strong：自我完备的「动作不在本条消息里」信号，命中即 multi。
const RE_STRONG = [
  { name: "@引用", re: /@[^\s，。；、：:）)\]】"'`]+/u },
  {
    name: "继续/按上面/同上",
    re: /继续|接着|按照上面|按上面|照上面|同上|照前面|如前述|参照上面|接上面|上述(方案|步骤|计划|清单|结论)/u,
  },
  { name: "依次/逐项执行", re: /(依次|逐项|逐条|逐个)(执行|处理|修改|检查|完成|做|改|跑)/u },
];

// guarded：本身可能出现在纯提问句里（「第 3 项是什么」），要求同时出现动作动词才算 multi。
const RE_GUARDED = [
  { name: "第N项/步/条/点", re: /第\s*[一二三四五六七八九十两0-9]+\s*(项|步|条|点)/u },
  { name: "指代上一轮", re: /我指的是|我说的|刚才(说的|那个)|就是上面(那个|这个)/u },
  { name: "帮我做N", re: /(帮我|请)(做|执行|完成|处理)\s*[0-9一二三四五六七八九十]+/u },
  { name: "N和M已完成", re: /^\s*[0-9一二三四五六七八九十]+\s*(和|、|,)\s*[0-9一二三四五六七八九十]+\s*(都)?已经/u },
  { name: "遍历全部/各工程", re: /(全部的|所有的|逐个工程|各个工程下|各工程下)/u },
];

const RE_ACTION =
  /改|写|做|加|删|跑|执行|部署|检查|查看|查|验证|安装|配置|重启|启动|新建|创建|生成|替换|更新|同步|提交|推送|测试|修|整理|迁移|合成|合并|拆|拉取|克隆|备份|恢复|回滚|对照|比对|统计|处理|优化/u;

// 纯提问句（以问号结尾且不含动作动词）一律不判 multi，避免误伤「第 3 项是什么？」
function looksLikePureQuestion(text) {
  return /[?？]\s*$/u.test(text) && !RE_ACTION.test(text);
}

export function regexHit(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  if (!text.trim()) return null;
  if (looksLikePureQuestion(text)) return null;
  for (const s of RE_STRONG) if (s.re.test(text)) return s.name;
  for (const s of RE_GUARDED) if (s.re.test(text) && RE_ACTION.test(text)) return s.name;
  return null;
}

// ---- key -------------------------------------------------------------------
function readKey(keyFile) {
  let k = "";
  try {
    k = String(fs.readFileSync(keyFile, "utf8") || "").replace(/^\uFEFF/, "").trim();
  } catch {
    k = "";
  }
  if (k) return k;
  try {
    return String(process.env.TYPESAFE_API_KEY || "").replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

// ---- 官方通道（pi ctx.modelRegistry） ---------------------------------------
/**
 * 走 pi 内置的 typesafe 分类器通道。正则已在 judge() 里判过，这里只负责发问。
 * 任何拿不到答案的情形（无 registry / 无模型 / stopReason 非 stop / 答案缺字段）一律返回 null，
 * 由 judge() 回退到 HTTP —— 本函数对外绝不抛错。
 * @param {any} registry pi 扩展的 ctx.modelRegistry
 * @param {{prompt:string, context?:string, timeoutMs?:number, threshold?:number, t0:number}} o
 */
async function callViaRegistry(registry, o) {
  let model = null;
  try {
    model =
      registry && typeof registry.findOfType === "function"
        ? registry.findOfType("classifier", "typesafe", "jev-latest")
        : null;
  } catch {
    model = null;
  }
  if (!model || typeof registry.classify !== "function") return null;

  let r = null;
  try {
    r = await registry.classify(
      model,
      {
        state: { request: o.prompt, recent_context: o.context || "(无)" },
        questions: { step: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA } },
      },
      { timeoutMs: o.timeoutMs },
    );
  } catch {
    return null;
  }
  if (!r || r.stopReason !== "stop") return null;

  const a = (r.answers && r.answers.step) || null;
  if (!a) return null;
  const probs = a.probabilities || null;
  let pMulti = null;
  if (probs && typeof probs[CAND_MULTI] === "number") pMulti = probs[CAND_MULTI];
  else if (a.choice === CAND_MULTI) pMulti = 1;
  else if (a.choice === CAND_SINGLE) pMulti = 0;
  if (pMulti === null) return null;

  // ⚠️ 官方 usage 的字段是 input/output（我们原来读的是 input_tokens/output_tokens）
  const usage = r.usage || {};
  return {
    cls: pMulti >= o.threshold ? "multi" : "single",
    pMulti,
    source: "jev",
    via: "registry",
    choice: a.choice || null,
    ms: Date.now() - o.t0,
    inTok: usage.input ?? 0,
    outTok: usage.output ?? 0,
  };
}

// ---- 调用 ------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callOnce({ endpoint, key, body, timeoutMs, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") throw new Error("no fetch available");
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await f(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res || res.ok !== true) throw new Error("http " + ((res && res.status) || "?"));
  return await res.json();
}

/**
 * @param {{prompt?:string, context?:string, timeoutMs?:number, threshold?:number,
 *          budgetMs?:number, keyFile?:string, endpoint?:string, fetchImpl?:Function,
 *          registry?:any}} [opts]
 *   registry 传 pi 的 ctx.modelRegistry 时优先走官方通道（见文件头「通道」段）。
 */
export async function judge(opts = {}) {
  const t0 = Date.now();
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  const context = typeof opts.context === "string" ? opts.context : "";
  const timeoutMs =
    Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : DEFAULTS.timeoutMs;
  const threshold = Number.isFinite(Number(opts.threshold))
    ? Number(opts.threshold)
    : DEFAULTS.threshold;
  const budgetMs =
    Number.isFinite(Number(opts.budgetMs)) && Number(opts.budgetMs) > 0
      ? Number(opts.budgetMs)
      : timeoutMs * 3;
  const endpoint = opts.endpoint || DEFAULTS.endpoint;
  const keyFile = opts.keyFile || DEFAULTS.keyFile;

  // ① 正则兜底：命中即 multi，不发网络请求
  const hit = regexHit(prompt);
  if (hit) {
    return {
      cls: "multi",
      pMulti: 1,
      source: "regex",
      via: "regex",
      choice: CAND_MULTI,
      regex: hit,
      ms: Date.now() - t0,
      inTok: 0,
      outTok: 0,
    };
  }

  const base = { cls: "single", pMulti: null, source: "jev", choice: null, inTok: 0, outTok: 0 };

  // ② 官方通道：有 registry 就先试它；失败静默落到底下的 HTTP，不影响可用性
  if (opts.registry) {
    const rr = await callViaRegistry(opts.registry, {
      prompt,
      context,
      timeoutMs,
      threshold,
      t0,
    });
    if (rr) return rr;
  }

  // ③ HTTP 兜底：自己读 key + fetch
  let key = "";
  try {
    key = readKey(keyFile);
  } catch {
    key = "";
  }
  if (!key) {
    return { ...base, ms: Date.now() - t0, error: "no key" };
  }

  const body = {
    state: { request: prompt, recent_context: context || "(无)" },
    model: DEFAULTS.model,
    questions: {
      step: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
    },
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= DEFAULTS.retryWaitsMs.length; attempt++) {
    try {
      const json = await callOnce({ endpoint, key, body, timeoutMs, fetchImpl: opts.fetchImpl });
      const a = (json && json.answers && json.answers.step) || null;
      const usage = (json && json.usage) || {};
      const probs = (a && a.probabilities) || null;
      let pMulti = null;
      if (probs && typeof probs[CAND_MULTI] === "number") pMulti = probs[CAND_MULTI];
      else if (a && a.choice === CAND_MULTI) pMulti = 1;
      else if (a && a.choice === CAND_SINGLE) pMulti = 0;
      if (pMulti === null) throw new Error("no answer");
      return {
        cls: pMulti >= threshold ? "multi" : "single",
        pMulti,
        source: "jev",
        via: "http",
        choice: (a && a.choice) || null,
        attempts: attempt + 1,
        ms: Date.now() - t0,
        inTok: usage.input_tokens ?? 0,
        outTok: usage.output_tokens ?? 0,
      };
    } catch (err) {
      lastErr = err;
      const wait = DEFAULTS.retryWaitsMs[attempt];
      const elapsed = Date.now() - t0;
      // 退避等待 + 下一次超时必须落在总预算内，否则不再重试
      if (wait === undefined || elapsed + wait + timeoutMs > budgetMs) break;
      await sleep(wait);
    }
  }
  return {
    ...base,
    ms: Date.now() - t0,
    error: String((lastErr && lastErr.message) || lastErr || "unknown"),
  };
}

export default judge;
