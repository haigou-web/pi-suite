// hard-rules/test.mjs — 纯逻辑单测（不启动 pi）
// 跑法：node modules/hard-rules/test.mjs
//
// 口径：只测 rules.mjs 的判定，不测 pi 侧包装。用例覆盖「该拦的必拦」与
// 「不该拦的绝不拦」（误伤代价比漏拦更高），以及放行/上限/试运行三条旁路。

import path from "node:path";
import fs from "node:fs";
import {
  decide,
  decideOutput,
  messageTextOf,
  applyOutputClean,
  RUBRIC_TAIL_WORDS,
  RUBRIC_COT_WORDS,
  RULE_LABEL,
  G1_HEDGE_WORDS,
  G1_IDIOM_WORDS,
  G1_TANGENT_WORDS,
  G1_RULES,
  G1_WARN_MAX,
  TAIL_SCAN_LINES,
  isGeneratorCmd,
  statementRunsGenerator,
  modelSpecified,
  readsMonicaSkill,
  isDocPath,
  extOf,
  docExtsIn,
  decideDocReminder,
  docReminderText,
  resolvePaths,
  REQUIRED_MODEL,
  MAX_SKILL_BLOCKS,
} from "./rules.mjs";

const HOME = "C:\\Users\\tester";
const P = resolvePaths(HOME);
const CWD = "C:\\work";

let pass = 0;
const fails = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
  } else {
    fails.push(name + (detail ? "  → " + detail : ""));
  }
}

function read(p, extra = {}) {
  const { input: extraInput, ...rest } = extra; // 注意：先展开 rest，否则 extra.input 会把 path 覆盖掉
  return decide({ toolName: "read", input: { path: p, ...(extraInput || {}) }, cwd: CWD, home: HOME, ...rest });
}

function shell(cmd, extra = {}) {
  return decide({
    toolName: extra.toolName || "powershell",
    input: { command: cmd },
    cwd: CWD,
    home: HOME,
    ...extra,
    input2: undefined,
  });
}

const GEN = [
  "pwsh -NoProfile -File",
  '"' + P.monicaGen + '"',
].join(" ");
const OK_MODEL = "-Model 'GPT Image 2.5 Flare'";

// ============ ① §7 read 直读文档 ============
for (const ext of [".pdf", ".PDF", ".docx", ".doc", ".dotx", ".pptx", ".potx", ".ppt", ".xlsx", ".xls"]) {
  const r = read("C:\\work\\a" + ext);
  ok("block read " + ext, r && r.block === true && r.tags.includes("doc-read"));
}
{
  const r = read("C:\\work\\a.pdf");
  ok("reason 含 to-md 脚本路径", r.reasons[0].includes(P.toMd));
  ok("reason 含绝对目标路径", r.reasons[0].includes("C:\\work\\a.pdf"));
  ok("reason 含预期 md 产物", r.reasons[0].includes("C:\\work\\a.md"));
  ok("reason 提到 §7", r.reasons[0].includes("§7"));
  ok("target 为 resolve 后绝对路径", r.target === "C:\\work\\a.pdf");
}
{
  const r = read("docs\\报告.pdf");
  ok("相对路径被 resolve", r && r.target === path.resolve(CWD, "docs\\报告.pdf"), r && r.target);
  ok("相对路径的 md 产物正确", r.reasons[0].includes(path.join(CWD, "docs", "报告.md")));
}
{
  const r = read('"C:\\work\\a.pdf"');
  ok("带引号路径被 unquote", r && r.target === "C:\\work\\a.pdf", r && r.target);
}
{
  const r = read("C:\\work\\a.pdf", { input: { offset: 0, limit: 20 } });
  ok("带 offset/limit 仍拦", r && r.block === true);
}
for (const p of ["C:\\work\\a.md", "C:\\work\\a.txt", "C:\\work\\a.json", "C:\\work\\a.csv", "C:\\work\\a.html", "C:\\work\\a.png", "C:\\work\\a.jpg", "C:\\work\\a.zip", "C:\\work\\a.ipynb", "C:\\work\\noext"]) {
  const r = read(p);
  ok("放行 read " + path.basename(p), r === null, r && JSON.stringify(r.tags));
}
for (const t of ["write", "edit", "grep", "find", "ls"]) {
  const r = decide({ toolName: t, input: { path: "C:\\work\\a.pdf" }, cwd: CWD, home: HOME });
  ok("放行非 read 工具 " + t, r === null);
}
ok("read 无 path → null", read("") === null && read(undefined) === null);
{
  const r = read("C:\\work\\a.pdf", { mode: "advise" });
  ok("advise 模式不拦但标记 wouldBlock", r && r.block === false && r.wouldBlock === true && r.tags.includes("doc-read"));
}
{
  const r = read("C:\\work\\a.pdf", { state: { monicaSkillRead: true, monicaSkillBlocks: 9 } });
  ok("文档硬拦不受 state 影响", r && r.block === true);
}

// ============ ② §8 monica 生图 ============
ok("isGeneratorCmd: generate.ps1", isGeneratorCmd("pwsh -File C:\\x\\generate.ps1") === true);
ok("isGeneratorCmd: monica 路径", isGeneratorCmd(GEN) === true);
ok("isGeneratorCmd: monica + generate 裸词", isGeneratorCmd("cd monica-ai-workflow; ./generate") === true);
ok("isGeneratorCmd: get-prompt.ps1 不拦", isGeneratorCmd("pwsh -File monica-ai-workflow\\scripts\\get-prompt.ps1") === false);
ok("isGeneratorCmd: table-edit.ps1 不拦", isGeneratorCmd("pwsh -File skills\\table-edit\\scripts\\table-edit.ps1") === false);
ok("isGeneratorCmd: 空命令", isGeneratorCmd("") === false);

ok("modelSpecified: 单引号", modelSpecified(`-File x.ps1 ${OK_MODEL}`) === true);
ok("modelSpecified: 双引号", modelSpecified('-Model "GPT Image 2.5 Flare"') === true);
ok("modelSpecified: 小写", modelSpecified("-model gpt image 2.5 flare") === true);
ok("modelSpecified: 多空格", modelSpecified("-Model   'GPT   Image 2.5 Flare'") === true);
ok("modelSpecified: auto 不算", modelSpecified("-Model auto") === false);
ok("modelSpecified: Recraft 不算", modelSpecified("-Model 'Recraft V3 Raw'") === false);
ok("modelSpecified: 缺失", modelSpecified("-File x.ps1 -Case 1") === false);

ok("readsMonicaSkill: 命中", readsMonicaSkill("cat monica-ai-workflow\\SKILL.md") === true);
ok("readsMonicaSkill: 只有 SKILL.md", readsMonicaSkill("cat other\\SKILL.md") === false);

{
  const r = shell(GEN + " " + OK_MODEL, { state: { monicaSkillRead: true } });
  ok("已读技能+模型正确 → 放行并留痕", r && r.block === false && r.tags.includes("monica-call-ok"), r && JSON.stringify(r.tags));
}
{
  const r = shell(GEN + " " + OK_MODEL);
  ok("未读技能 → 拦", r && r.block === true && r.tags.includes("monica-skill-read"));
  ok("未读技能 reason 指向 SKILL.md", r.reasons[0].includes(P.monicaSkill));
  ok("未读技能 reason 提到 §8", r.reasons[0].includes("§8"));
  ok("计数 +1", r.effects.monicaSkillBlocks === 1);
}
{
  const r = shell(GEN, { state: { monicaSkillRead: true } });
  ok("模型缺失 → 拦", r && r.block === true && r.tags.includes("monica-model"));
  ok("模型缺失 reason 给出可抄的 -Model", r.reasons[0].includes(`-Model '${REQUIRED_MODEL}'`));
  ok("模型缺失 reason 提到 Recraft 漂移", r.reasons[0].includes("Recraft"));
}
{
  const r = shell(GEN + " -Model auto");
  ok("模型=auto → 拦", r && r.block === true && r.tags.includes("monica-model"));
}
{
  const r = shell(GEN);
  ok("双违规 → 两条 reason 一次给全", r && r.block === true && r.reasons.length === 2 && r.tags.includes("monica-skill-read") && r.tags.includes("monica-model"));
}
{
  const r = shell(GEN + " " + OK_MODEL, { state: { monicaSkillBlocks: MAX_SKILL_BLOCKS } });
  ok("拦截达上限 + 模型正确 → 放行（防死锁）", r && r.block === false, r && JSON.stringify(r.tags));
  ok("放行时留下 override 痕迹", r && r.tags.includes("monica-skill-read-override"), r && JSON.stringify(r.tags));
}
{
  const r = shell(GEN, { state: { monicaSkillBlocks: MAX_SKILL_BLOCKS } });
  ok("拦截达上限但模型仍缺 → 仍拦模型", r && r.block === true && r.tags.includes("monica-model") && !r.tags.includes("monica-skill-read"));
}
{
  const cmd = "Get-Content '" + P.monicaSkill + "'; " + GEN + " " + OK_MODEL;
  const r = shell(cmd);
  ok("命令内自带读 SKILL.md → 视为已读", r && r.block === false && r.effects.monicaSkillRead === true, r && JSON.stringify(r.tags));
}
{
  const r = read(P.monicaSkill);
  ok("read 该 SKILL.md → 记状态且不拦", r && r.block === false && r.effects.monicaSkillRead === true && r.tags.includes("monica-skill-read-ok"));
}
{
  const r = shell("Get-Content '" + P.monicaSkill + "'");
  ok("cat 该 SKILL.md → 记状态", r && r.effects.monicaSkillRead === true && r.block === false);
  ok("cat 该 SKILL.md → 有 tag（否则包装层收不到状态）", r && r.tags.includes("monica-skill-read-ok"), r && JSON.stringify(r.tags));
}
{
  const r = shell(GEN + " " + OK_MODEL, { toolName: "bash", state: { monicaSkillRead: true } });
  ok("bash 工具同样适用", r && r.block === false && r.tags.includes("monica-call-ok"));
}
{
  const r = shell("pwsh -File skills\\monica-ai-workflow\\scripts\\pick-style.ps1 -Style 3");
  ok("pick-style 不拦", r === null);
}
{
  const r = shell("pwsh -File monica-ai-workflow\\scripts\\generate.ps1 -Model 'GPT Image 2.5 Flare'", { mode: "advise" });
  ok("advise 模式下未读也不拦", r && r.block === false && r.wouldBlock === true);
}
{
  const r = shell("pwsh -File monica-ai-workflow\\scripts\\generate.ps1 -Model 'GPT Image 2.5 Flare' -ClickConfirm", { state: { monicaSkillRead: true } });
  ok("真跑（带 -ClickConfirm）不额外拦", r && r.block === false);
}

// ============ ③ 工具函数边界 ============
ok("extOf 大小写", extOf("A.PDF") === ".pdf");
ok("isDocPath 无扩展名", isDocPath("C:\\work\\a") === false);
ok("decide 无参数不抛", (() => { try { decide(); return true; } catch { return false; } })() === true);
ok("decide 垃圾 input 不抛", (() => { try { decide({ toolName: "read", input: null, cwd: null, state: null }); return true; } catch { return false; } })() === true);

// ============ ④ 误伤回归（真实生产误拦过的命令，必须放行） ============
{
  // 2026-09-20 e2e 实测被误拦的原句：只是在列举两个文件的信息（含一个技能脚本路径）
  const GEN = "C:\\Users\\tester\\.pi\\agent\\skills\\demo-skill\\scripts\\generate.ps1";
  const cmd =
    "Get-Date -Format 'yyyy-MM-dd HH:mm ddd'; Get-Item 'C:\\w\\dummy.pdf','" +
    GEN +
    "' -ErrorAction SilentlyContinue | Select-Object Name,Length";
  ok("回归: Get-Item 列举路径不算运行脚本", isGeneratorCmd(cmd) === false);
  const r = shell(cmd);
  ok("回归: 该命令不被拦截", r === null, r && JSON.stringify(r.tags));
}
{
  ok("只读: Test-Path", isGeneratorCmd("Test-Path 'C:\\x\\generate.ps1'") === false);
  ok("只读: Get-Content 读脚本本身", isGeneratorCmd("Get-Content 'C:\\x\\generate.ps1'") === false);
  ok("只读: git commit 提到文件名", isGeneratorCmd('git commit -m "fix generate.ps1"') === false);
  ok("非 ps1: python 同名文件", isGeneratorCmd("python generate.py") === false);
  ok("注释/字符串: echo", isGeneratorCmd('echo "generate.ps1"') === false);
}
{
  ok("运行: -File + 带空格引号路径", isGeneratorCmd('pwsh -NoProfile -File "C:\\a b\\generate.ps1" -Case 1') === true);
  ok("运行: & 调用", isGeneratorCmd("& 'C:\\x\\generate.ps1' -Case 1") === true);
  ok("运行: 相对 .\\", isGeneratorCmd(".\\generate.ps1 -Case 1") === true);
  ok("运行: 裸绝对路径", isGeneratorCmd("C:\\x\\generate.ps1 -Case 1") === true);
  ok("运行: powershell 前缀", isGeneratorCmd("powershell -NoProfile -File C:\\x\\generate.ps1") === true);
  ok("运行: bash -c 包裹", isGeneratorCmd('bash -c "pwsh -File C:\\x\\generate.ps1 -Case 2"') === true);
  ok("运行: 同一串里先看再跑也要拦", isGeneratorCmd("Test-Path 'C:\\x\\generate.ps1'; pwsh -File 'C:\\x\\generate.ps1' -Case 1") === true);
}
{
  ok("读技能: Get-Item 列 SKILL.md 不算读过", readsMonicaSkill("Get-Item 'C:\\x\\monica-ai-workflow\\SKILL.md'") === false);
  ok("读技能: Select-String 算读过", readsMonicaSkill("Select-String -Path 'C:\\x\\monica-ai-workflow\\SKILL.md' -Pattern Model") === true);
  ok("读技能: echo 不算读过", readsMonicaSkill('echo "monica-ai-workflow/SKILL.md"') === false);
}

// ============ ⑤ 输出检查：rubric ④⑤（v1.2，只判定不改输出） ============
// 口径来源：外部 rubric §④ §⑤
//   ④ 无禁止收尾：扫末段（末行 + 末尾 3 个非空行），词表禁止收窄
//   ⑤ 无思维链泄露：扫全文
const BUG_TAIL = "需要我展开某一步的具体操作（如堆快照 diff 的命令…）吗？";

ok("TAIL_SCAN_LINES 与 rubric 一致（末尾 3 个非空行）", TAIL_SCAN_LINES === 3);
{
  // 回归 bug 用例：历史实现写成 `需要我.{0,4}吗`，把这条真阳性全漏了
  const r = decideOutput(["结论：先备份再改。", "", "依据：同上。", "", BUG_TAIL].join("\n"));
  ok("④ 回归：长反问收尾必须命中（词表不得收窄）", r.hit === true && r.rules.includes("④"), JSON.stringify(r.rules));
  ok("④ 回归：命中行进 wouldRemove", r.wouldRemove.includes(BUG_TAIL), r.wouldRemove);
  ok("④ 回归：scanScope=末段", r.scanScope === "末段", r.scanScope);
  ok("④ 回归：reason 供状态面板用", r.reason === "④ 末段客套收尾", r.reason);
}
ok("④「希望有帮助」命中", decideOutput("结论：A。\n希望有帮助").rules.includes("④"));
ok("④「随时找我」命中", decideOutput("结论：A。\n随时找我。").rules.includes("④"));
ok("④「还有什么…帮」命中", decideOutput("结论：A。\n还有什么可以帮您的吗？").rules.includes("④"));
ok("④「如有…问题」命中", decideOutput("结论：A。\n如有问题请告诉我。").rules.includes("④"));
{
  const t = ["随时问我：这是正文中间的一句客套。", "结论：先备份。", "依据：同上。", "下一步：跑 node test.mjs。"].join("\n");
  const r = decideOutput(t);
  ok("④ 只扫末段：正文中间同类词不命中", r.hit === false, JSON.stringify(r.rules) + r.wouldRemove);
}
{
  const r = decideOutput(["让我想想这个问题的边界。", "结论：A。", "下一步：跑 B。"].join("\n"));
  ok("⑤ 首行思维链泄露命中", r.hit === true && r.rules.includes("⑤"), JSON.stringify(r.rules));
  ok("⑤ scanScope=全文", r.scanScope === "全文", r.scanScope);
  ok("⑤ 命中行进 wouldRemove", r.wouldRemove.includes("让我想想"), r.wouldRemove);
}
ok("⑤ 正中间的泄露也命中（全文扫描）", decideOutput("结论：A。\n我在想这样对不对。\n下一步：跑 B。").rules.includes("⑤"));
ok("⑤「我需要先」命中", decideOutput("我需要先确认一下。\n结论：A。").rules.includes("⑤"));
ok("⑤「首先…分析」命中", decideOutput("首先我来分析一下。\n结论：A。").rules.includes("⑤"));
{
  const t = ["结论：已加 message_end 输出检查，advise 档只记录。", "", "依据：test.mjs 全绿。", "", "下一步：跑 node test.mjs 复核。"].join("\n");
  const r = decideOutput(t);
  ok("正常输出（结论 + 依据 + 可执行下一步）不命中", r.hit === false && r.rules.length === 0, JSON.stringify(r.hits));
}
ok("空文本不命中", decideOutput("").hit === false && decideOutput(null).hit === false && decideOutput(undefined).hit === false);
ok("全空白不命中", decideOutput("   \n\n\t \r\n").hit === false);
ok("只有一行标题不命中", decideOutput("# 结论").hit === false);
{
  const t = ["结论：先跑单测。", "", "```powershell", "node test.mjs", "```"].join("\n");
  ok("结尾是代码块不命中", decideOutput(t).hit === false);
}
ok(
  "decideOutput 垃圾输入不抛",
  (() => {
    try {
      decideOutput(12345);
      decideOutput({});
      decideOutput([]);
      decideOutput();
      return true;
    } catch {
      return false;
    }
  })() === true,
);
{
  const r = decideOutput("结论：A。\n希望有帮助", { mode: "advise" });
  ok("advise 档照样命中（改不改由 .ts 决定）", r.hit === true && r.mode === "advise");
}
{
  const t = ["让我想想。", "结论：A。", "", "希望有帮助"].join("\n");
  const r = decideOutput(t);
  ok("④⑤ 同时命中 → 一条记录里两条规则", r.rules.length === 2 && r.rules[0] === "④" && r.rules[1] === "⑤", JSON.stringify(r.rules));
  ok("④⑤ 命中行都进 wouldRemove", r.wouldRemove.includes("希望有帮助") && r.wouldRemove.includes("让我想想"), r.wouldRemove);
}
{
  const t = ["结论：A。", "", "如需进一步调整可以直接说。"].join("\n");
  const r = decideOutput(t, { mode: "on" });
  ok("on 档 cleaned 去掉末段客套", typeof r.cleaned === "string" && !r.cleaned.includes("如需进一步调整"), JSON.stringify(r.cleaned));
  ok("on 档 removeLines 给出被删原文", r.removeLines.includes("如需进一步调整可以直接说。"), JSON.stringify(r.removeLines));
}

// ============ ⑥ on 档纯函数（真改逻辑，单测可直接调） ============
{
  const msg = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "内部思考" },
      { type: "text", text: "结论：A。\n希望有帮助" },
    ],
  };
  const t = messageTextOf(msg);
  ok("messageTextOf 只取 text 块（忽略 thinking）", t === "结论：A。\n希望有帮助", JSON.stringify(t));
  ok("messageTextOf 支持 string content", messageTextOf({ content: "abc" }) === "abc");
  ok("messageTextOf 只有 toolCall 块 → 空串", messageTextOf({ content: [{ type: "toolCall", name: "read" }] }) === "");
  ok("messageTextOf 无 content 不抛", messageTextOf({}) === "" && messageTextOf(null) === "" && messageTextOf() === "");

  const r = decideOutput(t, { mode: "on" });
  const next = applyOutputClean(msg.content, r.removeLines);
  ok("applyOutputClean 清掉末段客套（只动 text 块）", next[1].text === "结论：A。", JSON.stringify(next[1].text));
  ok("applyOutputClean 保留 thinking 块与块数", next[0] === msg.content[0] && next.length === 2);
  ok("applyOutputClean 不改原对象", msg.content[1].text.includes("希望有帮助"), JSON.stringify(msg.content[1].text));
}
ok("applyOutputClean 无命中行 → 原样返回", applyOutputClean("x\ny", []) === "x\ny");
ok(
  "applyOutputClean 垃圾输入不抛",
  (() => {
    try {
      applyOutputClean(null, ["a"]);
      applyOutputClean(42, null);
      applyOutputClean("a\nb", undefined);
      return true;
    } catch {
      return false;
    }
  })() === true,
);

// ============ ⑦ 词表漂移测试（lab 文件存在才跑；生产代码不依赖该路径） ============
// 可用 PI_RUBRIC_MD 指定一份 rubric.md 来开启这项测试；未设置则跳过。
const RUBRIC_MD = process.env.PI_RUBRIC_MD || "";
if (!fs.existsSync(RUBRIC_MD)) {
  console.log("\n⏭  词表漂移测试跳过：rubric.md 不存在（" + RUBRIC_MD + "）——这是 lab 路径，生产不依赖它");
} else {
  const md = fs.readFileSync(RUBRIC_MD, "utf8");
  const sectionOf = (mark) => {
    const i = md.indexOf("## " + mark);
    if (i < 0) return "";
    const j = md.indexOf("\n## ", i + 3);
    return md.slice(i, j < 0 ? undefined : j);
  };
  // 取该小节里「禁止词表 / 词表」行的反引号内容，按 | 拆成词项列表
  const wordsOf = (sec, label) => {
    const m = sec.match(new RegExp("^\\|\\s*" + label + "\\s*\\|\\s*`([^`]+)`", "m"));
    return m ? m[1].split("|") : null;
  };
  const tailMd = wordsOf(sectionOf("④"), "禁止词表");
  const cotMd = wordsOf(sectionOf("⑤"), "词表");
  ok("漂移: rubric §④ 词表可解析", Array.isArray(tailMd) && tailMd.length === 12, JSON.stringify(tailMd));  // R4 加宽：9 → 12
  ok("漂移: rubric §⑤ 词表可解析", Array.isArray(cotMd) && cotMd.length === 7, JSON.stringify(cotMd));
  ok(
    "漂移: ④ 词表与 rules.mjs 逐项相同",
    JSON.stringify(tailMd) === JSON.stringify(RUBRIC_TAIL_WORDS),
    `rubric=${JSON.stringify(tailMd)} rules.mjs=${JSON.stringify(RUBRIC_TAIL_WORDS)}`,
  );
  ok(
    "漂移: ⑤ 词表与 rules.mjs 逐项相同",
    JSON.stringify(cotMd) === JSON.stringify(RUBRIC_COT_WORDS),
    `rubric=${JSON.stringify(cotMd)} rules.mjs=${JSON.stringify(RUBRIC_COT_WORDS)}`,
  );
}

// ============ ⑧ 保守改写（v1.3）：子句级手术 + 安全网 ============
// 口径来源：交付说明「要实现的语义（保守改写）」②③④⑤⑥⑦
const detailOf = (text, lines) => applyOutputClean(text, lines, { detail: true });
const hitsOf = (text) => decideOutput(text, { mode: "on" }).removeLines;

{
  // ②③ 仅客套的一行 → 整行删（其余行一字不动）
  const t = "结论：A。\n希望有帮助。";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 仅客套的行 → 整行删", r.to === "结论：A。" && r.removed === 1, JSON.stringify(r.to));
  ok("⑧ 整行删走规则 3", r.ops.length === 1 && r.ops[0].rule === "3", JSON.stringify(r.ops));
}
{
  // ② 内容 + 客套混排在同一行 → 只摘客套子句，其余保留
  const t = "结论：A。需要我展开吗？\n下一步：跑 B。";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 同行混排 → 只摘客套子句", r.to === "结论：A。\n下一步：跑 B。", JSON.stringify(r.to));
  ok("⑧ 混排走规则 2、不整行删", r.removed === 0 && r.ops[0].rule === "2" && r.ops[0].dropped === 7, JSON.stringify(r.ops));
}
{
  // ③ 列表项被删空 → 连 "- " 标记一起整行删
  const t = "- 结论 X 已确认。\n- 需要我展开吗？";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 列表项删空 → 整行含标记删", r.to === "- 结论 X 已确认。" && !r.to.includes("需要我"), JSON.stringify(r.to));
}
{
  // ④ 剩不到原行 40% → 不留残片，整行删
  const t = "结论：A。\n前言两句；需要我展开这一长串细节（包括 ABCDEFGHIJKLMNOPQRSTUVWXYZ 全部内容与说明）吗？";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 残片 <40% → 整行删（规则 4）", r.to === "结论：A。" && r.ops[0].rule === "4", JSON.stringify(r.to) + JSON.stringify(r.ops));
}
{
  // ③ 剩余非标点字符 < 2 → 整行删
  const t = "结论：A。\nA。需要我展开吗？";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 剩余非标点 <2 → 整行删（规则 3）", r.to === "结论：A。" && r.ops[0].rule === "3", JSON.stringify(r.to) + JSON.stringify(r.ops));
}
{
  // ⑤ 代码围栏内的命中行 → 跳过原文保留（随后被安全网 ⑦a 拦下整条回退）
  const t = "结论：A。\n```\n需要我展开吗？\n```";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 围栏内命中 → 跳过（记 skipped）", r.skipped === 1 && r.ops[0].rule === "5" && r.ops[0].skipped === true, JSON.stringify(r.ops));
  ok("⑧ 围栏跳过 → 安全网 7a 整条回退原文", r.reverted === true && r.revertReason === "7a" && r.content === t, r.revertReason);
}
{
  // ⑦a 命中跨句末标点（`希望.*有帮助` 跨过「。」）→ 子句级删不掉 → 整条回退，绝不半改
  const t = "希望你能理解。这有帮助。";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 安全网 7a：跨标点长匹配 → 回退原文", r.reverted === true && r.revertReason === "7a" && r.content === t, r.revertReason);
  ok("⑧ 跨标点行一字未动（noop）", r.ops.length === 1 && r.ops[0].noop === true && r.ops[0].after === r.ops[0].line, JSON.stringify(r.ops));
}
{
  // ⑦b 全部行都被摘掉 → 回退原文，绝不把消息清成空
  const t = "希望有帮助。\n需要我展开吗？";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 安全网 7b：清空 → 回退原文", r.reverted === true && r.revertReason === "7b" && r.content === t, r.revertReason);
  ok("⑧ 结果永不空", String(r.content).trim().length >= 1, JSON.stringify(r.content));
}
{
  // ② 多行同时命中 → 两行都改，行数只减不增
  const t = "结论：A。\n如需可以告诉我。\n需要我展开吗？\n下一步：跑 B。";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 多行同时命中", r.to === "结论：A。\n下一步：跑 B。" && r.removed === 2, JSON.stringify(r.to) + " removed=" + r.removed);
  ok("⑧ 其他行一字未动", r.to.startsWith("结论：A。\n") && r.to.endsWith("下一步：跑 B。"), JSON.stringify(r.to));
}
{
  // ② 同一行两次命中（首尾各一个客套子句）
  const t = "如需可以告诉我。结论 B：先备份再改，然后跑测试并复核日志。需要我展开吗？\n下一步：跑 C。";
  const r = detailOf(t, hitsOf(t));
  ok(
    "⑧ 同一行两次命中 → 只留中间那句",
    r.to === "结论 B：先备份再改，然后跑测试并复核日志。\n下一步：跑 C。" && r.removed === 0 && r.ops.length === 1,
    JSON.stringify(r.to) + JSON.stringify(r.ops),
  );
}
{
  // ⑥ 残留标点清理：摘掉末句后不留悬空的「；」
  const t = "结论：A。\n甲方案先备份数据库并复核日志；乙方案改配置再重启；需要我展开这一步吗？";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 悬空「；」被清掉", r.to === "结论：A。\n甲方案先备份数据库并复核日志；乙方案改配置再重启", JSON.stringify(r.to));
}
{
  // ② 连写标点（`？？`）整体跟随前句 → 不留孤零零的「？」
  const t = "需要我展开吗？？结论：先备份数据库再改配置，然后跑单测复核。";
  const r = detailOf(t, hitsOf(t));
  ok("⑧ 连写标点不残留孤立符号", r.to === "结论：先备份数据库再改配置，然后跑单测复核。", JSON.stringify(r.to) + JSON.stringify(r.ops));
}
{
  // ⑦c 恒等：未命中行、未命中消息一律原样返回
  const t = "结论：A。\n下一步：跑 B。";
  ok("⑧ 无命中行 → 恒等（string）", applyOutputClean(t, []) === t);
  ok("⑧ removeLines 与任何行都不匹配 → 恒等", applyOutputClean(t, ["不存在的行"]) === t);
  ok("⑧ 未命中 → detail 也不报改动", detailOf(t, []).reverted === false && detailOf(t, []).to === t);
  const arr = [
    { type: "thinking", thinking: "内部思考" },
    { type: "text", text: "结论：A。" },
  ];
  ok("⑧ 无命中行 → 恒等（数组同引用）", applyOutputClean(arr, []) === arr);
}
{
  // string 与数组两种 content：数组只动 text 块，thinking / toolCall 原对象返回
  const arr = [
    { type: "thinking", thinking: "内部思考" },
    { type: "text", text: "结论：A。\n希望有帮助。" },
    { type: "toolCall", name: "read" },
  ];
  const lines = hitsOf("结论：A。\n希望有帮助。");
  const next = applyOutputClean(arr, lines);
  ok("⑧ 数组 content：text 块被保守改写", next[1].text === "结论：A。", JSON.stringify(next[1].text));
  ok("⑧ thinking / toolCall 块同引用未改", next[0] === arr[0] && next[2] === arr[2] && next.length === 3);
  ok("⑧ 不改原对象", arr[1].text === "结论：A。\n希望有帮助。", JSON.stringify(arr[1].text));
  const d = detailOf(arr, lines);
  ok("⑧ detail：from/to 为该消息全部 text 块拼接", d.from === "结论：A。\n希望有帮助。" && d.to === "结论：A。", JSON.stringify(d.to));
  ok("⑧ 默认调用形式仍返回 content 本体", typeof applyOutputClean("结论：A。\n希望有帮助。", lines) === "string");
}
{
  // 数组里多个 text 块都要处理（拼接后再判定，逐块清理）
  const content = [
    { type: "text", text: "结论：A。" },
    { type: "text", text: "需要我展开吗？" },
  ];
  const lines = hitsOf("结论：A。\n需要我展开吗？");
  const d = detailOf(content, lines);
  ok("⑧ 多 text 块逐个清理", d.content[1].text === "" && d.content[0].text === "结论：A。", JSON.stringify(d.content.map((p) => p.text)));
  ok("⑧ 多 text 块：改后全文不再命中且非空", d.reverted === false && d.to.trim() === "结论：A。", JSON.stringify(d.to));
}

// ============ ⑨ G1（v1.4）：三类无信息量句子 —— 默认只告警，整行纯该类才删 ============
// 口径来源：外部技能 i-have-adhd Pre-send check 的三类
//   H1 空 hedge / H2 习语套话 / H3 侧栏跑题
// 分级（保守策略）：residual === 0 → remove；0 < residual ≤ G1_WARN_MAX → warn（只记账不删）；
//   更大 → 不算命中（行里有真内容）。反例一律检查「不许出现在 removeLines」。
const g1 = (text) => decideOutput(text, { mode: "on" });
const G1_HEAD = "结论：先备份再改。";

ok("G1: 三类词表均非空", G1_HEDGE_WORDS.length > 0 && G1_IDIOM_WORDS.length > 0 && G1_TANGENT_WORDS.length > 0);
ok("G1: 三类都有 rule id + 人话标签", G1_RULES.length === 3 && G1_RULES.every((d) => !!RULE_LABEL[d.rule]));
ok("G1: warn 阈值 = 6", G1_WARN_MAX === 6);

// ---- H1 空 hedge ----
{
  const r = g1([G1_HEAD, "这取决于具体情况。"].join("\n"));
  ok("H1 正例：独占一行的 hedge → 判删", r.rules.includes("H1") && r.removeLines.includes("这取决于具体情况。"), JSON.stringify(r.removeLines));
  const r2 = g1([G1_HEAD, "可能会…"].join("\n"));
  ok("H1 正例：省略号式 hedge → 判删", r2.removeLines.includes("可能会…"), JSON.stringify(r2.removeLines));
  const r3 = g1([G1_HEAD, "可能会出问题。"].join("\n"));
  ok("H1 warn：低信息 hedge → 只记账不删", r3.hit === true && r3.removeLines.length === 0 && r3.warnLines.includes("可能会出问题。"), JSON.stringify(r3.warnLines));
  ok("H1 warn：命中仍算 hit（.ts 才会写日志）", r3.hit === true && r3.rules.includes("H1") && r3.warnCount === 1, JSON.stringify(r3.rules));
  for (const anti of ["这可能会影响性能，需要实测才能确认。", "不一定需要重启，先看日志。", "大概是缓存没清导致的，清一下就好。"]) {
    const r4 = g1([G1_HEAD, anti].join("\n"));
    ok("H1 反例：有实义不许删 → " + anti.slice(0, 6), r4.removeLines.length === 0, JSON.stringify(r4.removeLines));
  }
}

// ---- H2 习语套话 ----
{
  const r = g1([G1_HEAD, "一举两得。"].join("\n"));
  ok("H2 正例：独占一行的成语 → 判删", r.rules.includes("H2") && r.removeLines.includes("一举两得。"), JSON.stringify(r.removeLines));
  const r2 = g1([G1_HEAD, "1. 手到擒来。"].join("\n"));
  ok("H2 正例：带列表标记的成语行 → 判删", r2.removeLines.includes("1. 手到擒来。"), JSON.stringify(r2.removeLines));
  const r3 = g1([G1_HEAD, "这样做一举两得。"].join("\n"));
  ok("H2 warn：成语夹在短句里 → 只记账不删", r3.hit === true && r3.removeLines.length === 0 && r3.warnLines.includes("这样做一举两得。"), JSON.stringify(r3.warnLines));
  for (const anti of [
    "这不是一举两得，而是拆东墙补西墙，需要选一个。",
    "手到擒来的前提是脚本已经写好了。",
    "说白了就是把 A 换成 B，其余不动。",
  ]) {
    const r4 = g1([G1_HEAD, anti].join("\n"));
    ok("H2 反例：有实义不许删 → " + anti.slice(0, 6), r4.removeLines.length === 0, JSON.stringify(r4.removeLines));
  }
}

// ---- H3 侧栏跑题（只扫末段）----
{
  const r = g1([G1_HEAD, "顺便一提。"].join("\n"));
  ok("H3 正例：末尾题外话 → 判删", r.rules.includes("H3") && r.removeLines.includes("顺便一提。"), JSON.stringify(r.removeLines));
  const r2 = g1([G1_HEAD, "顺便一提，还有个旧版。"].join("\n"));
  ok("H3 warn：末尾补白带一点内容 → 只记账不删", r2.hit === true && r2.removeLines.length === 0 && r2.warnLines.includes("顺便一提，还有个旧版。"), JSON.stringify(r2.warnLines));
  const r3 = g1(["顺便一提，先备份。", G1_HEAD, "依据：同上。", "下一步：跑 node test.mjs。"].join("\n"));
  ok("H3 反例：正文中段出现跑题词不扫（H3 只扫末段）", r3.hit === false, JSON.stringify(r3.hits));
  const r4 = g1([G1_HEAD, "顺便一提，回滚要跑 rollback.ps1 并先备份配置。"].join("\n"));
  ok("H3 反例：末尾行有实义不许删", r4.removeLines.length === 0, JSON.stringify(r4.removeLines));
}

// ---- G1 与 ④⑤ / 安全网 ⑦a 的交互 ----
{
  const t = "结论：A。\n大概是吧。\n希望有帮助。";
  const r = g1(t);
  ok("G1+④：warn 与可删共存 → rules 两条、scanScope=末段+全文", r.rules.join(",") === "④,H1" && r.scanScope === "末段+全文", JSON.stringify(r));
  const d = applyOutputClean(t, r.removeLines, { detail: true });
  ok("G1+④：warn 行不被删、可删行被摘", d.reverted === false && d.to === "结论：A。\n大概是吧。", JSON.stringify(d));
}
ok("G1: removableOnly 下只有 warn → 不算命中（⑦a 不被拖去回退）", decideOutput("结论：A。\n大概是吧。", { mode: "on", removableOnly: true }).hit === false);
ok("G1: removableOnly 下仍能看见可删命中", decideOutput("结论：A。\n希望有帮助。", { mode: "on", removableOnly: true }).hit === true);
{
  const r = g1([G1_HEAD, "需要我展开吗？", "一举两得。"].join("\n"));
  ok("G1: hits 带 action 字段（remove / warn）", r.hits.every((h) => h.action === "remove" || h.action === "warn"), JSON.stringify(r.hits));
  ok("G1: reason 用现有格式拼人话标签", r.reason.includes("H2 习语套话（修辞代替信息）"), r.reason);
}

// ============ §7 前置提醒（v1.6）============
{
  const D = docExtsIn("帮我看下 C:\\work\\报告.pdf 里说了什么");
  ok("§7提醒: 认出路径里的 pdf", D.length === 1 && D[0] === "C:\\work\\报告.pdf", JSON.stringify(D));
}
ok("§7提醒: 大写扩展名也认", docExtsIn("read REPORT.PDF").join("|") === "REPORT.PDF", JSON.stringify(docExtsIn("read REPORT.PDF")));
ok("§7提醒: 同名不同大小写只算一个", docExtsIn("a.docx 和 A.DOCX").length === 1, JSON.stringify(docExtsIn("a.docx 和 A.DOCX")));
ok("§7提醒: 旧格式 .ppt/.xls 也认", docExtsIn("老表.xls").length === 1, JSON.stringify(docExtsIn("老表.xls")));
ok("§7提醒: 假扩展名不认（a.pdfx）", docExtsIn("a.pdfx").length === 0, JSON.stringify(docExtsIn("a.pdfx")));
ok("§7提醒: 没提文档 → 不判定", decideDocReminder({ prompt: "帮我改下代码" }) === null);
ok("§7提醒: off 档不判定", decideDocReminder({ prompt: "看 报告.pdf", mode: "off" }) === null);
{
  const r = decideDocReminder({ prompt: "看 报告.pdf" });
  ok("§7提醒: 首次命中 → inject=true/fresh", r.hit === true && r.inject === true && r.reason === "fresh", JSON.stringify(r));
}
{
  const r = decideDocReminder({ prompt: "看 报告.pdf", seen: ["c:\\work\\报告.pdf"] });
  ok("§7提醒: 同一文件第二次 → 只留痕不注入（全路径与文件名视为同一个）", r.hit === true && r.inject === false && r.reason === "dedupe", JSON.stringify(r));
}
{
  const r = decideDocReminder({ prompt: "看 报告.pdf", mode: "advise" });
  ok("§7提醒: advise 档只留痕", r.hit === true && r.inject === false && r.reason === "advise", JSON.stringify(r));
}
{
  const t = docReminderText(["报告.pdf"], P);
  ok("§7提醒: 文本含 to-md.ps1 绝对路径", t.includes(path.join(HOME, ".pi", "agent", "skills", "doc-read", "scripts", "to-md.ps1")), t);
  ok("§7提醒: 文本含「生成/导出就忽略」出口", t.includes("忽略本行"), t);
  ok("§7提醒: 压成一行", t.split("\n").length === 1, t);
}

// ============ 汇总 ============
const total = pass + fails.length;
console.log(`\n${pass} passed / ${fails.length} failed  (共 ${total} 例)`);
if (fails.length) {
  console.log("\n失败用例：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exitCode = 1;
} else {
  console.log("EXIT=0");
}
