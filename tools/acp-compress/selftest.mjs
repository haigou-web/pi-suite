// selftest.mjs — acp-compress/judge.mjs 离线自检（不联网络）
// 覆盖：① 高档判定 ② 闲聊落 L0 ③ H2 硬规则把真实任务从 L1 拉回 L3 ④ H1 硬规则触发
// 用法：node selftest.mjs
import { score, scoreWithText, TIER_BUDGET } from "./judge.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)}${ok ? "" : ` want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ans = (loss, proc, uniq) => {
  const A = {};
  if (loss) A.lossIfDropped = { choice: Object.keys(loss)[0], probabilities: loss };
  if (proc) A.processRatio = { choice: Object.keys(proc)[0], probabilities: proc };
  if (uniq) A.uniqueness = { choice: Object.keys(uniq)[0], probabilities: uniq };
  return A;
};

// ① 高价值段（用户明确要求 + 只此一处）→ L4
const A1 = ans(
  { 必须保留: 0.9, 有用: 0.08, 可弃: 0.02 },
  { 结论为主: 0.8, 半过程: 0.15, 过程为主: 0.05 },
  { 仅此一处: 0.5, 别处也有但不全: 0.3, 别处也有: 0.2 }
);
eq("① 高价值段档位", scoreWithText("用户要求：阈值 0.40 写死", A1).tier, "L4");

// ② 闲聊/自我确认 → L0（不能被 uniqueness 抬起来）
const A2 = ans(
  { 必须保留: 0.02, 可弃: 0.9, 有用: 0.08 },
  { 过程为主: 0.9, 半过程: 0.08, 结论为主: 0.02 },
  { 仅此一处: 0.05, 别处也有: 0.9 }
);
const r2 = scoreWithText("好的，我明白了，那我继续想一下这个问题。", A2);
eq("② 闲聊档位", r2.tier, "L0");
eq("② 无硬规则触发", r2.floors, []);

// ③ 真实任务但概率给低了（复现 v3 的 S23 过降）→ H2 拉回 L3
const A3 = ans(
  { 必须保留: 0.1, 有用: 0.2, 可弃: 0.7 },
  { 半过程: 0.6, 结论为主: 0.2, 过程为主: 0.2 },
  { 仅此一处: 0.4, 别处也有但不全: 0.3, 别处也有: 0.3 }
);
const r3 = scoreWithText("这条规则要求阈值 0.40，改完重启后生效。", A3);
eq("③ 硬规则把过降拉回（S=0.102→L0）", [r3.tierRaw, r3.tier], ["L0", "L3"]);

// ④ H1：P(必须保留)>0.30 但不含关键信息 → 至少 L2
const A4 = ans({ 必须保留: 0.5, 有用: 0.3 }, { 过程为主: 0.9, 结论为主: 0.05 }, { 别处也有: 0.9 });
const r4 = scoreWithText("用户明确说过要保留的中文规则说明", A4);
eq("④ H1 兜底（S=0.17→L1）", [r4.tierRaw, r4.tier, r4.floors[0]], ["L1", "L2", "H1:P(必须保留)>0.30:L2"]);

// ⑤ 预算映射与 base 公式
eq("⑤ 预算映射", [TIER_BUDGET.L0, TIER_BUDGET.L2, TIER_BUDGET.L4], [30, 200, 1000]);
eq("⑤ base 公式", score({ lossIfDropped: { probabilities: { 必须保留: 0.5, 有用: 0.5 } } }).base, 0.7);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
