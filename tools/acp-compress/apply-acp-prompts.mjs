// apply-acp-prompts.mjs — 把「v4 长度定档（P2′） + 四行模板」规则写入 ~/.pi/acp.json 的 prompts.howToCompressRules
//
// 背景：acp.json 的 prompts.* 是**整段替换**语义（写什么就用什么，覆盖 billion-context-pi 的英文默认版）。
// 用法：
//   node apply-acp-prompts.mjs --dry   只打印，不写入
//   node apply-acp-prompts.mjs         写入（自动留 .bak-<时间戳>，已存在则不覆盖备份）
// 验证：写完后 JSON.parse 回读 + 打印长度与首段。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi 配置目录：默认 ~/.pi，可用 PI_CONFIG_DIR 覆盖
const PI_DIR = process.env.PI_CONFIG_DIR || path.join(os.homedir(), ".pi");
const AC = path.join(PI_DIR, "acp.json");

export const TEXT = `HOW TO COMPRESS（本机定制 v4 · 2026-10-02 生效 · P2′ 长度为主）

一、先定档（查表，不许凭感觉）
看 acp_status 里每个区间后面的 token 数，直接对表：

≤ 8K tok   → L1（≤80 tok）：只留“做了什么 + 结论”
8K–30K     → L2（≤200 tok，**默认档**）：套下面四行模板
30K–55K    → L3（≤500 tok）：四行 + 依据（关键命令 / 数值 / 路径 / 版本号）
> 55K      → L4（≤1000 tok）：四行 + 依据 + 复现要素（环境 / 前置条件 / 不可逆操作）

L0（≤30 tok，直接丢弃）：只给**纯寒暄、自我确认、无信息量的工具回显**，且该区间 < 1K tok。
短但含用户指令的区间一律走 L1，不要因为短就丢。

单次压缩的总量约束：
· 一次调用里 **L3/L4 合计最多 1 个区间**——已用过高档后，其余区间一律封顶 L2。

硬规则（覆盖长度表，只抬不降）：
H1 区间含“用户明确要求 / 已被否决的方案 / 只此一处出现的路径·端口·阈值·版本号” → 不低于 L2
H2 区间含 密钥·token、端口、阈值、版本号、不可逆操作、已否决项 → 不低于 L3
  （2026-09-26 起「文件路径 / 文件名后缀」不再算 H2 信号：实测命中率 61%~78%，会把 L2 默认档清零）
  （查档脚本：node ~/.pi/agent/extensions/pi-suite/modules/acp-compress/judge.mjs --p2 <tok> …）

为什么不再自评打分（实测结论）：
Jev 的「丢了会怎样 / 结论占比 / 是否仅此一处」三问，与人工标注的“该留多少”相关 τ ≤0.20（95 块扩样后甚至反向）；
三位独立标注者之间也只有 τ=0.587（连人都排不稳）。→ 价值无法稳定判定，
改用长度（唯一有微弱正向信号、且零成本的量）+ 硬规则保底。

二、四行模板（每个区间都按它写）
来源：<起止范围 + 那几步在干什么>（1 行内）
最终结论：<结论/决定/数值，带路径与版本号>（3 行内；L0 可省）
涉及文件：<路径：关键函数/字段>（L1 可省）
未完成：<半截的活 + 已知坑；没有就写“无”>
L3/L4 追加「依据」（关键命令/参数/阈值/实测数字）与「复现要素」（环境/前置条件/不可逆操作）。

三、写法铁律（原规则保留）
· 你的摘要就是该区间的唯一记录：必须自包含且完整，覆盖每一个用户请求、实验目的、工作任务；后来者不看原文也能接着干。
· 只写结论与状态，不写过程叙述；不确定的写“未验证”；禁止编造数字。
· 记录过去状态写成历史（“截至此块：…”），不要写成待执行的指令。
· 全文中文；专有名词/路径/命令/代码保留原样；使用真实 unicode 字符。
· 单块摘要 ≤1000 字符（超出会被工具截断，实测有块被截到 279 字符）。
· 写完自检：只拿这份摘要，能不能继续干活？不能就补到能。`;

const main = () => {
  const dry = process.argv.includes("--dry");
  const j = JSON.parse(fs.readFileSync(AC, "utf8"));
  const before = String(j.prompts?.howToCompressRules || "");
  if (!j.prompts) throw new Error("acp.json 里没有 prompts 字段");
  if (TEXT.length > 6000) throw new Error(`规则过长(${TEXT.length})，疑似写错`);
  if (!dry && !fs.existsSync(AC + ".bak-writer")) fs.copyFileSync(AC, AC + ".bak-writer");
  j.prompts.howToCompressRules = TEXT;
  if (dry) { console.log(`[dry] ${before.length} → ${TEXT.length} 字符\n\n${TEXT}`); return; }
  fs.writeFileSync(AC, JSON.stringify(j, null, 2) + "\n", "utf8");
  const back = JSON.parse(fs.readFileSync(AC, "utf8"));
  console.log(`写入完成: ${before.length} → ${String(back.prompts.howToCompressRules).length} 字符`);
  console.log("回读校验:", JSON.parse(fs.readFileSync(AC, "utf8")).prompts.howToCompressRules.slice(0, 60).replace(/\n/g, "⏎"));
  console.log("其他字段保持:", Object.keys(back.prompts).join(", "), "| acknowledgePromptsRisk:", back.acknowledgePromptsRisk);
};

main();
