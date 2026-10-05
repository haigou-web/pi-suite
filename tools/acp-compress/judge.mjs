// judge.mjs — ACP 压缩「分段定档」打分器（Jev 三问 + 乘法公式 + 硬规则兜底）
//
// 用途：给「要被折叠进摘要」的一段历史打分，决定它该占多少摘要预算（L0~L4）。
//   ⚠️ 与 multistep-gate/judge.mjs 完全无关：那个判「本轮是多步还是单答」，这个判「这段该留多少」。
//
// 三问设计（在 12 例真实样本上调优）：
//   v1 value/kind/reuse            → 10 个真实任务段全部顶格 L4（判"内容包含什么"必然全中）
//   v2 loss/superseded/uniqueness  → 出现了中间档，但 ① 闲聊被 uniqueness 抬到 L1 ② superseded 11/12 判「未被覆盖」= 废维度
//   v3 loss/processRatio/uniqueness→ 分布 L0:3 L1:1 L2:3 L3:2 L4:3，均值 0.416 / σ 0.361，闲聊回落 L0
// 关键教训：
//   ① 判据要问「丢了会怎样 / 结论占多少」，不能问「内容多不多」；
//   ② uniqueness 必须当**乘数**（否则无所指的段落会被"仅此一处"抬起来）；
//   ③ 任何需要"看到后续消息"才能判的问题（如旧版 superseded）Jev 在孤立片段上必然答不出。
//
// 硬规则（覆盖 S 分，防止过降；v3 实测 S23 21.6K 字符真实任务被判 L0）：
//   H1  P(必须保留) > 0.30            → 不低于 L2
//   H2  段内出现密钥·token/端口/阈值/版本号/不可逆·已否决 → 不低于 L3（2026-09-26 已删去「文件路径/文件名后缀」一类宽分支）
//
// ⚠️ 2026-10-02 起：**生产定档已切换为 P2′（长度为主）**，Jev 三问退出压缩主循环。
//   依据：95 块 × 3 位独立标注者实验：
//     · Jev 各问法（含 noul 布尔版、含 18 块扩样）与「该留多少」的 τ 全部 ≤0.20；
//     · 标注者**之间** τ 仅 0.587（连人都排不稳）→ 无可用价值信号；
//     · 长度是唯一有微弱正向信号的量（τ≈0.20）且零成本。
//   新入口：tierForBlock(tok, text) / tierFromTokens(tok)，见下方「P2′ 生产定档」段。
//   下方 score / scoreWithText / callJev **保留仅供实验复现，不再用于生产**。
//
// 用法：
//   import { tierForBlock, TIER_BUDGET } from "./judge.mjs";
//   const r = tierForBlock(24000, 片段文本);        // { tok, tier, budget, floors }
//   node judge.mjs --p2 <token数> [更多...]         // CLI：只看 P2′ 定档
//   node judge.mjs <片段文件>                       // CLI 自测：调 Jev（实验用）
//
// key：只读 <PI_AGENT_DIR>/.typesafe_key.txt（可被 TYPESAFE_API_KEY 环境变量兜底），不打印、不落日志。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";

// 档位 → 摘要预算（token）。落点校验：v3 在 12 例上平均 398 tok/例，实测现状摘要 454 tok/例。
export const TIER_BUDGET = { L0: 30, L1: 80, L2: 200, L3: 500, L4: 1000 };

export const QUESTIONS = {
  // 判「反事实损失」：不判信息量
  lossIfDropped: {
    type: "choice",
    instructions: `假设这段内容在被摘要时被丢弃，最坏会发生什么？只按"最坏后果"选择。
注意：信息量大、写得很详细、包含多个文件路径，都不是选高档的理由——只有"丢了会出事"才是。
- 必须保留：丢弃会导致后续做出错误决定、重复用户已否决的方案、或无法复现某个已验证的结论。典型情形：某个文件路径/端口/阈值/版本号/密钥只在这里出现过；或用户的明确要求只在这里被记下。
- 有用：丢弃不会出错，但以后要用时得重新推导或重新查一次。
- 可弃：纯过程叙述（"我先查一下""结果发现"）、自我确认、寒暄、工具调用的过程描述，丢弃后没有任何影响。`,
    criteria: {
      "必须保留": "丢弃会造成错误决定、重复已否决方案，或结论不可复现",
      "有用": "丢弃只会多一次重查或重推，不会出错",
      "可弃": "丢弃后没有任何可观察的影响",
    },
  },
  // 段内可判：结论 vs 过程占比（替代需要全局视野的「是否已被后续覆盖」）
  processRatio: {
    type: "choice",
    instructions: `只依据本段文字判断，不要猜测后续对话。这段内容里，将来还会被用到的部分（结论、决定、最终产物、配置清单、用户的明确要求）占多大比例？
- 结论为主：几乎没有过程叙述，内容本身就是结论、配置、清单或决定。
- 半过程：结论与过程混杂在一起，去掉过程后核心信息仍然完整。
- 过程为主：绝大部分篇幅是试错、搜索、读代码、来回确认、自我复述，可用的结论只占很小一部分。`,
    criteria: {
      "结论为主": "几乎没有过程叙述，内容本身即结论/配置/清单",
      "半过程": "结论与过程混杂，去掉过程后核心仍完整",
      "过程为主": "绝大部分是试错、搜索、确认过程，结论只占很小一部分",
    },
  },
  uniqueness: {
    type: "choice",
    instructions:
      "这段里出现过的具体信息——文件路径、数值、命令、版本号、用户明确要求——在会话其他位置是否也出现过？",
    criteria: {
      "仅此一处": "所有具体信息都只能在这里找到",
      "别处也有但不全": "部分信息别处有，但不完整",
      "别处也有": "具体信息在别处已有完整记录",
    },
  },
};

// 硬规则 H2 的触发信号：只收**稀缺强信号**。
// ⚠️ 2026-09-26 全案例测试（23 例真实对话）发现：原先还包含「盘符路径 / ~目录 / 常见文件名后缀」，
//    这三个分支命中率高达 61%~78%（技术对话里它们是常态），导致 H2 几乎恒触发、91.3% 的段被抬到 L3/L4，
//    L2 默认档被清零、节省效果归零 → 已按方案 A 删除这三个宽分支。
const RE_CRITICAL =
  /(密钥|密码|secret|api[_ -]?key|bearer|token|端口|阈值|threshold|版本号|回滚|不可逆|已否决|不要用|禁止|v\d+\.\d+(\.\d+)?)/iu;

// ─────────── P2′ 生产定档（2026-10-02 生效）───────────
// 切点标定：105 个会话 / 1220 块池，区间 token 分位数 p25=7200、p60=30800、p85=52200
//   → 取整为 8K / 30K / 55K。实测平均预算 363 tok，相对近期实测摘要均值 578 tok 省 37%。
//   刻意保守：实测返工率已有 7.3%（decompress 31 / compress 425），不宜再压狠。
export const P2_CUTS = { L1: 8000, L2: 30000, L3: 55000 };

// H1 的 P2′ 版本：改判**文本信号**（原 H1 依赖 Jev 的 P(必须保留)，该量已退出主循环）
const RE_H1 = /(用户(?:明确)?(?:要求|说了|指定|说过)|已否决|否决了|不要用|别用|禁止|只此一处|唯一来源)/u;

/**
 * 按区间长度定档（P2′ 核心）。
 * @param {number} tok 该区间压缩前的 token 数（acp_status 里每段后面的数字）
 * @param {boolean} highEndUsed 本次压缩中是否已有区间用了 L3/L4（true 则本次封顶 L2）
 */
export function tierFromTokens(tok, { highEndUsed = false } = {}) {
  const t = Math.max(0, Number(tok) || 0);
  const base = t <= P2_CUTS.L1 ? "L1" : t <= P2_CUTS.L2 ? "L2" : t <= P2_CUTS.L3 ? "L3" : "L4";
  if (highEndUsed && (base === "L3" || base === "L4")) return "L2";
  return base;
}

/** 长度定档 + 硬规则保底，产出最终档位与预算 */
export function tierForBlock(tok, text, { highEndUsed = false } = {}) {
  const floors = [];
  let tier = tierFromTokens(tok, { highEndUsed });
  if (RE_H1.test(String(text || ""))) { floors.push(["H1", "文本含用户明确要求 / 已否决 / 只此一处信号", "L2"]); tier = noLower(tier, "L2"); }
  if (RE_CRITICAL.test(String(text || ""))) { floors.push(["H2", "段内含稀缺强信号（密钥·token·端口·阈值·版本号·不可逆·已否决）", "L3"]); tier = noLower(tier, "L3"); }
  return { tok: Number(tok) || 0, tier, budget: TIER_BUDGET[tier], floors: floors.map((f) => f.join(":")) };
}
// ─────────────────────────────────────────────────────

const tierOf = (S) => (S >= 0.8 ? "L4" : S >= 0.6 ? "L3" : S >= 0.35 ? "L2" : S >= 0.15 ? "L1" : "L0");
const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const noLower = (t, floor) => (rank[t] >= rank[floor] ? t : floor);

/** 只按概率算 S 与档位（不含硬规则） */
export function score(answers) {
  const p = (n, l) => answers?.[n]?.probabilities?.[l] ?? 0;
  const pMust = p("lossIfDropped", "必须保留");
  const base = 1.0 * pMust + 0.4 * p("lossIfDropped", "有用");
  const uniqMul = 1 + 0.3 * p("uniqueness", "仅此一处"); // 乘数：base=0 时抬不动
  const procPen = 0.5 * p("processRatio", "过程为主");
  const S = base * uniqMul - procPen;
  return { S: +S.toFixed(3), tier: tierOf(S), base: +base.toFixed(3), pMust, uniqMul, procPen,
    choice: { loss: answers?.lossIfDropped?.choice, proc: answers?.processRatio?.choice, uniq: answers?.uniqueness?.choice } };
}

/** 按概率 + 段内文本套硬规则，给出最终档位 */
export function scoreWithText(text, answers) {
  const r = score(answers);
  const floors = [];
  if (r.pMust > 0.3) floors.push(["H1", "P(必须保留)>0.30", "L2"]);
  if (RE_CRITICAL.test(text || "")) floors.push(["H2", "段内含稀缺强信号（密钥·token·端口·阈值·版本号·不可逆·已否决）", "L3"]);
  let tier = r.tier;
  for (const [, , f] of floors) tier = noLower(tier, f);
  return { ...r, tierRaw: r.tier, tier, floors: floors.map((f) => f.join(":")) , budget: TIER_BUDGET[tier] };
}

/** 调 Jev（3 问一次请求）。返回 answers 对象；失败抛错（调用方决定是否退化为全 L2）。 */
export async function callJev(text, { timeoutMs = 5000, keyFile = null, endpoint = ENDPOINT } = {}) {
  const kf = keyFile || path.join(AGENT_DIR, ".typesafe_key.txt");
  let key = process.env.TYPESAFE_API_KEY || "";
  if (!key) key = fs.readFileSync(kf, "utf8").replace(/^\uFEFF/, "").trim();
  const body = {
    state: {
      request:
        "请评估这段历史对话片段：如果它被摘要丢弃，最坏的后果是什么？这段内容里将来还会被用到的结论占多大比例？其中的具体信息在别处是否也出现过？",
      recent_context: String(text || "").slice(0, 3000),
    },
    model: MODEL,
    questions: QUESTIONS,
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`jev ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  return { answers: json.answers || {}, usage: json.usage, ms: null };
}

// CLI 自测（仅当本文件被直接执行时才触发；用路径比较，防止被名字以 judge.mjs 结尾的外部脚本 import 时误触发）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = process.argv[2];
  if (f === "--p2") {
    const toks = process.argv.slice(3).map(Number).filter((n) => n > 0);
    if (!toks.length) { console.log("用法: node judge.mjs --p2 <token数> [更多...]"); process.exit(1); }
    console.log("无约束：");
    for (const t of toks) { const r = tierFromTokens(t); console.log(`  ${String(t).padStart(8)} tok → ${r} (≤${TIER_BUDGET[r]} tok)`); }
    console.log("带单次总量约束（同一次压缩里 L3/L4 合计最多 1 个区间）：");
    let used = false;
    for (const t of toks) { const r = tierFromTokens(t, { highEndUsed: used }); console.log(`  ${String(t).padStart(8)} tok → ${r} (≤${TIER_BUDGET[r]} tok)`); if (r === "L3" || r === "L4") used = true; }
    process.exit(0);
  }
  if (!f) { console.log("用法: node judge.mjs <片段文件>  或  node judge.mjs --p2 <token数...>"); process.exit(1); }
  const text = fs.readFileSync(f, "utf8");
  const t0 = Date.now();
  callJev(text).then(({ answers, usage }) => {
    const r = scoreWithText(text, answers);
    console.log(JSON.stringify({ ...r, usage, ms: Date.now() - t0 }, null, 2));
  }).catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
