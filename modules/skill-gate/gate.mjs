// gate.mjs — 「技能路由闸门」纯逻辑模块（生产用；被 pi 扩展 skill-gate.ts 与回放器 replay-gate.mjs 共用）
//
// 语义来源（逐字照抄，禁止改写措辞）：gate-none.ps1 的初版探针脚本
//     - CHOICE_INSTRUCTIONS / RERANK_INSTRUCTIONS / NONE_DESC / 3 个 gateProbes / retry 表 3,10,25,45s / 请求体结构
//   决策规则来源：同目录 路由实测报告.md §6.6
//     stage-1: 全部候选 choice + 3 个 noul 探针 → 取 top-3
//     stage-2: top-3 + none 再做 choice（fits:: 探针仅作观测，不参与决策）
//     decision: load ⟺ winner 属于 top-3 且 pNone < 0.40
//
// 通道（2026-10-03 起双通道；结果里的 via 字段标明走了哪条）：
//   ① "registry" —— 调用方传了 opts.registry（= pi 的 ctx.modelRegistry）时优先走**官方通道**
//      registry.classify()：key 交给 pi 的 provider 认证层统一解析，与 pi 内置 Jev 通道完全同源。
//   ② "http" —— 原来的自读 key + fetch 直连（退避表 3,10,25,45s）。registry 不可用 / 报错时静默回退。
//   两条通道发的 state/questions 结构逐字一致，故决策口径不变，**绝不比原来更容易失败**。
//   ⚠️ 官方 classify() **从不抛异常**：失败只体现为 stopReason:"error"+errorMessage，故不能只靠 try/catch 判成败。
//
// 纪律：本模块对外绝不抛错。任何超时 / 网络 / 解析失败都降级为 { skill:null, error:"..." }。
//       模块顶层不做任何可能抛错的事（顶层只声明常量与函数）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
export const SHORTLIST = 3;
export const P_NONE_THRESHOLD = 0.40;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_KEY_FILE = process.env.PI_SKILL_GATE_KEY_FILE || path.join(AGENT_DIR, ".typesafe_key.txt");
// 向后兼容：早期版本放在实验目录里的那份 key，可用环境变量指定；默认为空（跳过）
export const LEGACY_KEY_FILE = process.env.PI_SKILL_GATE_LEGACY_KEY_FILE || "";
export const DEFAULT_LOG_PATH = process.env.PI_SKILL_GATE_LOG || path.join(LOG_DIR, "skill-gate.jsonl");

// gate-none.ps1: $wait = @(3, 10, 25, 45)
const RETRY_WAITS_MS = [3000, 10000, 25000, 45000];

// ---- 以下 4 段常量与 gate-none.ps1 逐字节一致 ----
const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?";
const RERANK_INSTRUCTIONS =
  "At most one of these skills is the right one to load for the user's latest request. Read what each actually does, not just its name. Which one is it? If none of them is genuinely the right skill for what the user is asking, choose 'none'.";
const NONE_DESC =
  "No skill should be loaded. None of the candidates is genuinely the right skill for what the user is asking.";
const GATE_PROBES = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
};
// ---------------------------------------------------

function errMessage(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  const msg = err && err.message ? String(err.message) : String(err);
  if (name === "TimeoutError" || name === "AbortError") return "timeout: " + msg;
  return msg;
}

function readKeyFromEnvOrFile() {
  const fromEnv = String(process.env.TYPESAFE_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  // 稳定路径优先，旧实验室路径回退（见文件头“脆弱点”说明）
  for (const p of [DEFAULT_KEY_FILE, LEGACY_KEY_FILE]) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const key = raw.replace(/^\uFEFF/, "").trim();
      if (key) return key;
    } catch {
      // 试下一个候选
    }
  }
  throw new Error("no-api-key-file");
}

// 惰性读 key：只在真正要走 HTTP 时才需要它（官方通道由 pi 的认证层解析凭据）。
function ensureKey(budget) {
  if (budget.key) return;
  budget.key = readKeyFromEnvOrFile(); // 读不到会抛 no-api-key-file → 上层 catch → error
}

function normalizeSkills(skills) {
  if (!Array.isArray(skills)) return [];
  const out = [];
  for (const s of skills) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.name !== "string" || !s.name) continue;
    out.push({
      name: s.name,
      description: typeof s.description === "string" ? s.description : "",
      description_full:
        typeof s.description_full === "string" ? s.description_full : undefined,
      body: typeof s.body === "string" ? s.body : undefined,
    });
  }
  return out;
}

// SKILL.md → { description_full, body }：从 SKILL.md 文本推导。
// 实验用的 roster.json 就是该脚本生成的；生产路径必须复刻它，否则 stage-1/2 的候选文本与实测口径不一致。
// 顶层只声明函数，不做任何可能抛错的事；读取失败一律返回 null（调用方回退到 pi 给的 description）。
const BODY_CHARS = 1600;
const deriveCache = new Map();

export function deriveFromSkillFile(filePath) {
  try {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    const st = fs.statSync(filePath);
    const hit = deriveCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const c = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const fmMatch = /^---(.*?)\r?\n---/s.exec(c);
    const fm = fmMatch ? fmMatch[1] : "";
    const dm = /description:\s*(?:[|>][-+]?\s*)?\n?(.*?)(?=\r?\n[a-zA-Z_-]+:\s|$)/s.exec(fm);
    let desc = dm ? dm[1].replace(/\s+/g, " ").trim() : "";
    desc = desc.replace(/^-\s*/, "");
    let body = c.replace(/^---.*?\r?\n---\r?\n/s, "").replace(/\s+/g, " ").trim();
    if (body.length > BODY_CHARS) body = body.slice(0, BODY_CHARS);
    const value = { description_full: desc, body };
    deriveCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return null;
  }
}

function fullDescription(skill) {
  if (!skill) return "";
  if (typeof skill.description_full === "string" && skill.description_full) return skill.description_full;
  return skill.description || "";
}

// stage-1 请求体：全候选 choice + 3 个 gate:: 探针（照抄 gate-none.ps1 $q1）
function buildStage1Body(prompt, skills) {
  const criteria = {};
  // 实验口径：gate-none.ps1 $q1 用的是 $s.description（= roster 里由 SKILL.md 推导的 description）
  for (const s of skills) criteria[s.name] = fullDescription(s);
  const questions = {
    which: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria },
  };
  for (const [k, v] of Object.entries(GATE_PROBES)) {
    questions["gate::" + k] = { type: "noul", instructions: v };
  }
  return { state: { request: prompt, recent_context: "" }, model: MODEL, questions };
}

// stage-2 请求体：top-3 + none 的 choice + fits:: 探针（照抄 gate-none.ps1 $q2）
function buildStage2Body(prompt, skills, top3) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const criteria = {};
  for (const name of top3) {
    const s = byName.get(name);
    const desc = fullDescription(s);
    const body = s && typeof s.body === "string" ? s.body.slice(0, 700) : "";
    // gate-none.ps1: ("{0} - {1}" -f $s.description_full, $ex)
    criteria[name] = body ? desc + " - " + body : desc;
  }
  criteria["none"] = NONE_DESC;
  const questions = {
    which: { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria },
  };
  for (const name of top3) {
    questions["fits::" + name] = {
      type: "noul",
      instructions:
        "Does the skill '" + name + "' do the specific thing the user's request asks for? It is described as: " +
        fullDescription(byName.get(name)),
    };
  }
  return { state: { request: prompt, recent_context: "" }, model: MODEL, questions };
}

function rankedProbabilities(resp) {
  const probs = resp && resp.answers && resp.answers.which ? resp.answers.which.probabilities : null;
  if (!probs || typeof probs !== "object") return [];
  // PS: Get-Props | Sort-Object -Property value -Descending（稳定排序）
  return Object.entries(probs)
    .map(([name, p]) => ({ name, p: Number(p) }))
    .sort((a, b) => b.p - a.p);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 官方通道（pi ctx.modelRegistry） ---------------------------------------
/**
 * 走 pi 内置的 typesafe 分类器通道。返回值**转成与 HTTP 响应同一形状**
 * （{answers, usage:{input_tokens,output_tokens}}），使上层的 rankedProbabilities / winner 提取逻辑完全不用改。
 * 任何拿不到答案的情形（无 registry / 无模型 / stopReason 非 stop / 缺 which 答案）一律返回 null → 回退 HTTP。
 * 本函数对外绝不抛错。
 * @param {any} registry pi 扩展的 ctx.modelRegistry
 * @param {object} body 与 HTTP 通道同一个请求体（含 state / questions / model）
 * @param {number} timeoutMs
 */
async function callViaRegistry(registry, body, timeoutMs) {
  let model = null;
  try {
    model =
      registry && typeof registry.findOfType === "function"
        ? registry.findOfType("classifier", "typesafe", MODEL)
        : null;
  } catch {
    model = null;
  }
  if (!model || typeof registry.classify !== "function") return null;

  let r = null;
  try {
    // 只把 state/questions 交给官方通道：model 由它自己的 model.id 决定（我们 body.model 与它同值，剥掉更干净）
    r = await registry.classify(model, { state: body.state, questions: body.questions }, { timeoutMs });
  } catch {
    return null;
  }
  // 官方失败不抛异常，只体现为 stopReason:"error"
  if (!r || r.stopReason !== "stop") return null;
  const answers = r.answers;
  if (!answers || !answers.which) return null;

  // ⚠️ 官方 usage 字段是 input/output（HTTP 那边是 input_tokens/output_tokens）
  const usage = r.usage || {};
  return {
    answers,
    usage: {
      input_tokens: usage.input ?? 0,
      output_tokens: usage.output ?? 0,
    },
  };
}

// 单次 HTTP 调用 + 退避重试（退避表照抄 gate-none.ps1）。所有尝试共享同一 deadline。
async function callTS(body, deadline, budget) {
  ensureKey(budget); // 惰性：走通官方通道时根本不需要它
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastErr || new Error("timeout");
    try {
      budget.calls += 1;
      const res = await fetch(budget.endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + budget.key,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) throw new Error("http " + res.status);
      const json = await res.json();
      const usage = (json && json.usage) || {};
      budget.inTok += Number(usage.input_tokens) || 0;
      budget.outTok += Number(usage.output_tokens) || 0;
      return json;
    } catch (err) {
      lastErr = err;
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined) throw lastErr;
      // 剩余预算装不下这次退避 → 直接放弃（8s 总预算下通常走这里）
      if (Date.now() + wait >= deadline) throw lastErr;
      budget.retries += 1;
      await sleep(wait);
    }
  }
  throw lastErr || new Error("unknown");
}

// 单阶段调用：官方通道优先，任何失败静默落回 HTTP。两条通道返回**同一形状**的响应对象。
async function callStage(body, deadline, budget) {
  const remaining = deadline - Date.now();
  if (budget.registry && remaining > 0) {
    budget.calls += 1;
    const r = await callViaRegistry(budget.registry, body, remaining);
    if (r) {
      budget.inTok += Number(r.usage.input_tokens) || 0;
      budget.outTok += Number(r.usage.output_tokens) || 0;
      budget.via.push("registry");
      return r;
    }
  }
  budget.via.push("http");
  return await callTS(body, deadline, budget);
}

function writeLog(logPath, entry) {
  try {
    const p = typeof logPath === "string" && logPath.trim() ? logPath : DEFAULT_LOG_PATH;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // 日志失败绝不影响返回
  }
}

/**
 * 技能路由闸门。
 * @param {object} opts
 * @param {string} opts.prompt     用户原始请求
 * @param {Array}  opts.skills     候选技能 [{name, description, description_full?, body?}]
 * @param {string} [opts.key]      TypeSafe API key（缺省 env TYPESAFE_API_KEY → .typesafe_key.txt；走官方通道时不需要）
 * @param {any}    [opts.registry] pi 的 ctx.modelRegistry；传了则优先走官方通道，失败静默回退 HTTP
 * @param {string} [opts.endpoint] 仅测试用：覆盖 HTTP 通道的 endpoint（默认 api.typesafe.ai）
 * @param {number} [opts.timeoutMs] 整体超时（两次调用共享），默认 8000
 * @param {string} [opts.logPath]  JSONL 日志路径
 * @returns {Promise<{skill:string|null,winner:string|null,pNone:number|null,top3:string[],via:string|null,calls:number,ms:number,inTok:number,outTok:number,error?:string}>}
 */
export async function route(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const prompt = typeof o.prompt === "string" ? o.prompt : "";
  const skills = normalizeSkills(o.skills);
  const timeoutMs = Number.isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0
    ? Number(o.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const logPath = typeof o.logPath === "string" && o.logPath.trim() ? o.logPath : DEFAULT_LOG_PATH;

  const t0 = Date.now();
  const budget = {
    calls: 0,
    inTok: 0,
    outTok: 0,
    retries: 0,
    key: "",
    registry: o.registry && typeof o.registry === "object" ? o.registry : null,
    endpoint: typeof o.endpoint === "string" && o.endpoint.trim() ? o.endpoint.trim() : ENDPOINT,
    via: [],
  };
  let top3 = [];
  let winner = null;
  let pNone = null;
  let skill = null;
  let error;

  try {
    if (!prompt.trim()) throw new Error("empty-prompt");
    if (skills.length === 0) throw new Error("no-skills");
    // key 改为惰性：显式传了就用，否则等真正要发 HTTP 时再由 ensureKey 读（官方通道不需要 key）
    if (typeof o.key === "string" && o.key.trim()) budget.key = o.key.trim();

    const deadline = t0 + timeoutMs;

    const r1 = await callStage(buildStage1Body(prompt, skills), deadline, budget);
    const ranked = rankedProbabilities(r1);
    if (ranked.length === 0) throw new Error("stage1-no-probabilities");
    top3 = ranked.slice(0, SHORTLIST).map((x) => x.name);

    const r2 = await callStage(buildStage2Body(prompt, skills, top3), deadline, budget);
    winner = (r2 && r2.answers && r2.answers.which && r2.answers.which.choice) || null;
    const probs2 = (r2 && r2.answers && r2.answers.which && r2.answers.which.probabilities) || {};
    pNone = probs2 && probs2.none !== undefined && probs2.none !== null ? Number(probs2.none) : null;

    // 决策（路由实测报告.md §6.6）：winner 属于 top-3 且 pNone < 0.40 才加载
    skill =
      winner && winner !== "none" && top3.includes(winner) && pNone !== null && pNone < P_NONE_THRESHOLD
        ? winner
        : null;
  } catch (err) {
    error = errMessage(err);
  }

  const via =
    budget.via.length === 0
      ? null
      : budget.via.every((v) => v === "registry")
        ? "registry"
        : budget.via.every((v) => v === "http")
          ? "http"
          : "mixed";
  const result = {
    skill,
    winner,
    pNone,
    top3,
    via,
    calls: budget.calls,
    ms: Date.now() - t0,
    inTok: budget.inTok,
    outTok: budget.outTok,
  };
  if (error) result.error = error;

  writeLog(logPath, {
    ts: new Date().toISOString(),
    prompt: prompt.slice(0, 80),
    nSkills: skills.length,
    top3,
    winner,
    pNone,
    decided: skill,
    via,
    calls: budget.calls,
    retries: budget.retries,
    ms: result.ms,
    inTok: result.inTok,
    outTok: result.outTok,
    ...(error ? { error } : {}),
  });

  return result;
}

export default route;
