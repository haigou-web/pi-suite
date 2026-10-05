// hard-rules/rules.mjs — 「硬规则守卫」纯判定逻辑（无 pi 依赖，可被单测直接 import）
//
// 只拦两类「高代价且零歧义」的违规，其余一律放行（宁可漏拦，不可误伤）：
//   ① AGENTS.md §7：禁止用 read 直读 .pdf/.docx/.pptx/.xlsx —— 必须先跑 doc-read 的 to-md.ps1 转成 md
//   ② AGENTS.md §8：monica 生图必须显式 -Model 'GPT Image 2.5 Flare'（省略/auto 会漂成 Recraft V3 Raw），
//      且真跑前必须先读 monica-ai-workflow/SKILL.md
//
// 依据：docs/extensions.md:778-840（tool_call 可返回 {block:true,reason} 否决本次调用；
// event.input 可原地改）。API 能力边界见 pi 官方 docs/extensions.md。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ══════════════════════════════════════════════════════════════════════
// 词表配置：默认读同目录的 rules-config.json，可用 PI_HARD_RULES_CONFIG 指向自己的副本。
// 读不到 / 解析失败 → 回退到下面的最小内置默认（规则变少，但绝不抛错）。
// ══════════════════════════════════════════════════════════════════════
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PI_HARD_RULES_CONFIG || path.join(__dirname, "rules-config.json");

const BUILTIN = {
  requiredModel: "your-image-model",
  maxSkillBlocks: 2,
  tailScanLines: 3,
  g1WarnMax: 6,
  rubricTailWords: ["希望有帮助", "随时问我", "需要我"],
  rubricCotWords: ["让我想想", "我需要分析"],
  cotThinkWords: ["好，执行", "好，现在", "那就执行"],
  jargonMap: { "钩子": "自动触发点", "落盘": "存进文件" },
  g1HedgeWords: ["可能会", "大概是", "看情况吧"],
  g1IdiomWords: ["一举两得", "说白了就是"],
  g1TangentWords: ["顺便一提", "题外话"],
  ruleLabel: {
    "④": "末段客套收尾",
    "⑤": "思维链泄露",
    J1: "行话词（黑话/内部术语）",
    R7: "思维链复读（过渡语空转）",
    H1: "空 hedge（只有铺垫没有信息）",
    H2: "习语套话（修辞代替信息）",
    H3: "侧栏跑题（末尾无关补白）",
  },
};

function loadConfig() {
  try {
    return { ...BUILTIN, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return BUILTIN;
  }
}
const CFG = loadConfig();

export const REQUIRED_MODEL = CFG.requiredModel;

// 同一会话最多拦 N 次「没先读 SKILL.md」，之后放行并留痕 —— 防止一个不肯读的 agent 被死锁。
export const MAX_SKILL_BLOCKS = CFG.maxSkillBlocks;

// 只覆盖真正的文档二进制。刻意不含 .png/.jpg（read 原生支持看图，误拦代价高）、
// 也不含 .csv/.json/.html/.ipynb（纯文本，直读无害）。
export const DOC_EXT = new Set([
  ".pdf", ".docx", ".dotx", ".doc", ".pptx", ".potx", ".ppt", ".xlsx", ".xls",
]);

export const SHELL_TOOLS = new Set(["bash", "powershell", "pwsh", "shell", "sh", "zsh", "cmd"]);

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

export function resolvePaths(home = HOME) {
  return {
    home,
    toMd: path.join(home, ".pi", "agent", "skills", "doc-read", "scripts", "to-md.ps1"),
    toMdColumns: path.join(home, ".pi", "agent", "skills", "doc-read", "scripts", "to-md-columns.ps1"),
    monicaGen: path.join(home, ".pi", "agent", "skills", "monica-ai-workflow", "scripts", "generate.ps1"),
    monicaSkill: path.join(home, ".pi", "agent", "skills", "monica-ai-workflow", "SKILL.md"),
  };
}

function unquote(s) {
  let t = String(s == null ? "" : s).trim();
  const q = t[0];
  if (t.length >= 2 && (q === '"' || q === "'") && t.endsWith(q)) t = t.slice(1, -1);
  return t.trim();
}

export function extOf(p) {
  const t = unquote(p);
  return t ? path.extname(t).toLowerCase() : "";
}

export function isDocPath(p) {
  return DOC_EXT.has(extOf(p));
}

export function isShellTool(toolName) {
  return SHELL_TOOLS.has(String(toolName || "").toLowerCase());
}

export function cmdOf(input) {
  const i = input || {};
  const c = i.command ?? i.cmd ?? i.script ?? "";
  return typeof c === "string" ? c : "";
}

// 只读类动词：这些开头的语句就算提到了脚本路径，也只是「看」不是「跑」
const READONLY_HEADS =
  /^(?:get-item|gi|get-childitem|gci|test-path|select-object|select-string|get-content|gc|cat|type|more|less|head|tail|where|which|get-command|find|findstr|grep|ls|dir|node|python|py|echo|write-host|get-date|resolve-path|get-filehash|copy-item|move-item|remove-item|del|rm|erase|new-item|ni)\b/i;

// 真正会读文件内容的动词（用于「命令自己读了 SKILL.md」的判定）
const READ_HEADS = /^(?:get-content|gc|cat|type|more|less|head|tail|select-string|findstr|grep|bat)\b/i;

// 按语句切分（; && || | 换行）：误伤的反面是「路径出现在别的语句里」
export function splitStatements(cmd) {
  return String(cmd || "")
    .split(/[;&|\n]+|\s+(?:-and|-or)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 单条语句是否真的在「运行」monica 生图脚本（而非 Get-Item / Test-Path / 注释里提到它）
export function statementRunsGenerator(st) {
  const s = String(st || "").trim();
  if (!s) return false;
  const mentions =
    /generate\.ps1/i.test(s) || (/monica-ai-workflow/i.test(s) && /\bgenerate\b/i.test(s));
  if (!mentions) return false;

  if (/(?:^|\s)-(?:File|f)\s+["']?[^"'|;]*generate\.ps1/i.test(s)) return true; // pwsh -File <path>
  if (/^&\s*["']?[^"'|;]*generate\.ps1/i.test(s)) return true; // & <path>
  if (/^(?:pwsh|powershell|cmd|bash|sh|wsl|start|call)\b[^|;]*generate\.ps1/i.test(s)) return true; // pwsh <path>
  if (/^\.\s+["']?[^"'|;]*generate\.ps1/i.test(s)) return true; // . <path> 点源
  if (/^["']?[^\s"']*[\\/]generate(?:\.ps1)?\b/i.test(s)) return true; // .\generate.ps1 / C:\x\generate.ps1

  return false; // 其余（只读动词开头的多语句）不算运行 —— 这是防误伤的兑底线
}

export function isGeneratorCmd(cmd) {
  const s = String(cmd || "");
  const statements = splitStatements(s);
  if (statements.some(statementRunsGenerator)) return true;
  // 退化情形：整串提到 monica 工作流，且有语句在直接调用名为 generate 的东西（可能没写 .ps1）
  if (/monica-ai-workflow/i.test(s)) {
    return statements.some(
      (st) => !READONLY_HEADS.test(st) && /(?:^|[\\/])generate\b/i.test(st)
    );
  }
  return false;
}

export function modelSpecified(cmd) {
  return /-Model\s+['"`]?GPT\s+Image\s+2\.5\s+Flare/i.test(String(cmd || ""));
}

// 命令里自己读了 SKILL.md（cat / Get-Content / gc）→ 视为已满足「先读」
// 注意：必须限定在读类动词开头的语句上，否则 Get-Item 列路径也会被误认成「读过了」
export function readsMonicaSkill(cmd) {
  return splitStatements(cmd).some(
    (st) => READ_HEADS.test(st) && /SKILL\.md/i.test(st) && /monica-ai-workflow/i.test(st)
  );
}

export function isMonicaSkillPath(abs, p) {
  const a = String(abs || "").toLowerCase();
  if (!a) return false;
  if (a === String(p.monicaSkill).toLowerCase()) return true;
  return /monica-ai-workflow/.test(a) && /skill\.md$/.test(a);
}

// ── §7 前置提醒（v1.6）：用户消息里出现文档文件名 → 请求开始就注入一行 ─────
// 与 ① 的分工：① 是「我已经动手直读」时才拦（tool_call，事后）；这里是还没决定怎么读就先说清读法。
// 只认扩展名，不做语义判断（宁可漏，不可误伤）；同一会话同一个文件名只提醒一次。
const DOC_TOKEN_RE =
  /[^\s"'`<>|*?()[\]{}，。；：、]+\.(?:pdf|docx|dotx|doc|pptx|potx|ppt|xlsx|xls)(?![a-z0-9])/gi;

export function docExtsIn(text) {
  const s = String(text == null ? "" : text);
  const out = [];
  const seen = new Set();
  DOC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DOC_TOKEN_RE.exec(s)) !== null) {
    const tok = m[0].trim();
    const key = tok.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(tok);
    }
  }
  return out;
}

// 去重键 = 文件名（basename，小写）：同一个文件写成全路径还是只写文件名，只算一个
export function docKey(tok) {
  const s = String(tok == null ? "" : tok).trim().replace(/^["']+|["']+$/g, "");
  try {
    return path.basename(s).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/**
 * 判定「本轮该不该注入 §7 提醒」。
 * @returns null（没提到文档）| { hit, tokens, fresh, inject, reason }
 *   inject=true → 调用方注入 { message }；false → 只留痕（advise / 同会话重复）
 */
export function decideDocReminder({ prompt, seen = [], mode = "on" } = {}) {
  if (mode === "off") return null;
  const tokens = docExtsIn(prompt);
  if (tokens.length === 0) return null;
  const known = new Set((Array.isArray(seen) ? seen : []).map((x) => docKey(x)));
  const fresh = tokens.filter((t) => !known.has(docKey(t)));
  if (fresh.length === 0) return { hit: true, tokens, fresh, inject: false, reason: "dedupe" };
  if (mode === "advise") return { hit: true, tokens, fresh, inject: false, reason: "advise" };
  return { hit: true, tokens, fresh, inject: true, reason: "fresh" };
}

// 一行提醒（刻意压成一句：注入内容每轮都在上下文里，越短越好）
export function docReminderText(fresh, p = resolvePaths()) {
  const list = (Array.isArray(fresh) ? fresh : [fresh]).join(" / ");
  return (
    "[硬规则 §7] 本请求涉及 " +
    list +
    "：读这类文件先转 md 再读，不要直接 read 正文 —— " +
    `pwsh -NoProfile -File "${p.toMd}" -Path "<绝对路径>"` +
    "（转完用 read 读产出的 .md；只是要生成/导出这类文件就忽略本行。）"
  );
}

function docReadReason(abs, p) {
  const md = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + ".md");
  return [
    "[硬规则 §7] 禁止用 read 直读文档二进制（.pdf/.docx/.pptx/.xlsx 等）——读出来是乱码，整轮白烧。",
    "正确路径是先转 md 再读（路径已是绝对路径，原样跑）：",
    `  pwsh -NoProfile -File "${p.toMd}" -Path "${abs}"`,
    `预期产物：${md}（脚本会打印 OUT / CHARS / headings 回执）`,
    "拿到回执后再用 read 读那个 .md，并按需检索；若 CHARS 很小（扫描件/图片型 PPT），",
    "按 doc-read 技能的退路分流（双栏 PDF 用同目录的 to-md-columns.ps1）。",
  ].join("\n");
}

function skillReadReason(p) {
  return [
    "[硬规则 §8] 真跑 monica 生图前必须先读技能文件（参数以它为准，不要凭记忆）：",
    `  read  ${p.monicaSkill}`,
    "读完再重跑你刚才那条命令（脚本参数见 SKILL.md §B）。",
  ].join("\n");
}

function modelReason() {
  return [
    "[硬规则 §8] monica 生图必须显式指定模型，否则会静默漂成 Recraft V3 Raw：",
    `  在命令里加：-Model '${REQUIRED_MODEL}'`,
    "（另：真跑前先跑一次不带 -ClickConfirm 的配置轮，核对模型 / 比例 / 画质。）",
  ].join("\n");
}

/**
 * 判定一次工具调用。
 * @returns null（无关调用，不记录） | { block, wouldBlock, tags, reasons, target, effects, mode }
 *   block=true  → 调用方应返回 {block:true, reason}
 *   block=false 且 tags 非空 → 命中了规则但放行（用于留痕/试运行）
 */
export function decide({ toolName, input, cwd, state, mode = "on", home = HOME } = {}) {
  const p = resolvePaths(home);
  const st = state && typeof state === "object" ? state : {};
  const name = String(toolName || "").toLowerCase();
  const tags = [];
  const reasons = [];
  const effects = {};
  let target = "";
  const base = cwd || process.cwd();

  // ---- ① read 直读文档二进制 ----
  if (name === "read") {
    const raw = unquote((input || {}).path ?? (input || {}).filePath ?? "");
    if (raw) {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
      if (isDocPath(raw)) {
        tags.push("doc-read");
        reasons.push(docReadReason(abs, p));
        target = abs;
      } else if (isMonicaSkillPath(abs, p)) {
        effects.monicaSkillRead = true; // 正常途径读了 SKILL.md
        tags.push("monica-skill-read-ok");
        target = abs;
      }
    }
  }

  // ---- ② monica 生图（shell 工具） ----
  if (isShellTool(name)) {
    const cmd = cmdOf(input);
    if (cmd) {
      const skillReadInCmd = readsMonicaSkill(cmd);
      if (skillReadInCmd) effects.monicaSkillRead = true;

      if (isGeneratorCmd(cmd)) {
        target = cmd.replace(/\s+/g, " ").slice(0, 240);
        const modelOk = modelSpecified(cmd);
        const skillOk = st.monicaSkillRead === true || skillReadInCmd;
        const blocks = Number(st.monicaSkillBlocks || 0);
        const overridden = !skillOk && blocks >= MAX_SKILL_BLOCKS;

        if (!skillOk && !overridden) {
          tags.push("monica-skill-read");
          reasons.push(skillReadReason(p));
          effects.monicaSkillBlocks = blocks + 1;
        } else if (overridden) {
          // 拦到上限后放行：必须留痕，否则「守卫放弃了」这件事没人知道
          tags.push("monica-skill-read-override");
        }
        if (!modelOk) {
          tags.push("monica-model");
          reasons.push(modelReason());
        }
        if (modelOk && skillOk) tags.push("monica-call-ok"); // 留痕：规则被遵守
      } else if (skillReadInCmd) {
        // 命令自己读了 SKILL.md（cat / Get-Content）→ 记状态。
        // 必须有 tag，否则 decide 返回 null，包装层会提前 return、状态永不生效。
        tags.push("monica-skill-read-ok");
        target = cmd.replace(/\s+/g, " ").slice(0, 240);
      }
    }
  }

  if (reasons.length === 0) {
    if (tags.length === 0) return null;
    return { block: false, wouldBlock: false, tags, reasons: [], target, effects, mode };
  }

  return {
    // advise（试运行）只留痕不拦截
    block: mode !== "advise",
    wouldBlock: true,
    tags,
    reasons,
    target,
    effects,
    mode,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 输出检查（v1.2）—— 针对「助手说完一段话」之后的检查，与上面两条工具调用规则互不干扰
//
// 判据来源：外部 rubric 的 §④ §⑤（词表逐字复制，禁止收窄；漂移由 test.mjs 断言）
// v1.4 追加 G1 三类（H1/H2/H3，来源见上方 G1 段），与 ④⑤ 共用本函数，互不干扰。
//   ④ 无禁止收尾：扫描范围 = 末段（末行 + 末尾 3 个非空行，逐行匹配）
//   ⑤ 无思维链泄露：全文逐行匹配
//   J1 行话词（v1.5）：全文逐行匹配，命中即「改写」（行话词→白话，见 JARGON_MAP / plainOf）
// 词表纪律：`.*` 必须保持无界。历史事故：`需要我.{0,4}吗` 把长反问句全漏了。
// 说明：扫描单位是「行」（rubric 对 ④ 明确如此定义），故 `.*` 只在单行内生效、不跨行。
// ══════════════════════════════════════════════════════════════════════

// ④ 禁止词表（来源：外部 rubric §④「禁止词表」行，逐项顺序照抄）
export const RUBRIC_TAIL_WORDS = CFG.rubricTailWords;

// ⑤ 思维链词表（来源：外部 rubric §⑤「词表」行，逐项顺序照抄）
export const RUBRIC_COT_WORDS = CFG.rubricCotWords;

// R7 thinking 通道词表（v1.7，2026-10-04）——「思维链自己在复读」
//
// 与 ⑤ 的分工：⑤ 管「思维链内容泄漏进正文」（text 块，rubric 词表锁定）；
// R7 管「thinking 块内部的过渡语空转」（如每写两段就来一句「好，执行」）。
// 与 ④⑤J1 的区别：本表**不锁 rubric.md**（无漂移断言），由本文件维护、可增删。
// 判定口径：**整行精确匹配**（行首尾允许句末标点/空白）—— 只在整行就是过渡语时删，
//   含过渡语的正文行（「好，执行完这步我核对了哈希」）一律不碰。
// 证据（2026-10-04 实测当前会话 jsonl）：「好，执行」x163、「好、执行」x56、「好，现在」x29、
//   「现在执行」x19、「好的，执行」x6、「那就执行」x6、「那么执行」x5、「好，开始」x4、
//   「好，接下来」x3、**100% 落在 thinking 字段，text 里 0 条**（这正是 ⑤ 抓不到的原因）。
export const COT_THINK_WORDS = CFG.cotThinkWords;

// ④ 的扫描范围：末尾 3 个非空行（末行必定在其中）
export const TAIL_SCAN_LINES = CFG.tailScanLines;

// ══════════════════════════════════════════════════════════════════════
// J1 行话词（v1.5，2026-09-22 用户要求「行话词进代码，命中就把那句删掉」）
//
// 与 ④⑤ 的区别：④⑤ 的词表逐字锁定 rubric.md（禁止收窄，漂移有测试断言）；
// J1 是「说给人听的话里别用黑话」—— 词表由本文件维护，可增删，加词只改删除敏感度、不改 ④⑤ 口径。
// 扫描范围与 ⑤ 同口径（全文逐行）；命中即改写（行话词→白话，见 JARGON_MAP / plainOf），不删句子。
// 已知取舍：「钩子」在与用户讨论插件机制时是正当技术名词，同样会被摘掉。
// 遇到这类话题把该词从下表删掉，或临时 `.pi-hard-rules=off` 关掉改写。
// ══════════════════════════════════════════════════════════════════════
// v1.5.1（用户指令「让代码改写是更合适的策略」）：判据从「删」改成「改写」——
// 命中后把行话词换成白话（下表），句子照旧留在回复里；只有 ④ 客套收尾才走删除。
// 纪律：右边那列白话里**不得再出现任何行话词**，否则改完仍命中 → 安全网 ⑦a 会把整条消息回退原文。
// 已知代价：逐词替换不看语法，可能出现「会保底」这类略生硬的说法 —— 右边随时可改成更顺口的人话。
export const JARGON_MAP = CFG.jargonMap;
// 词表 = 映射表的键（单一来源，避免两张表漂移）；长词优先由 altOf 处理（幂等性 先于 幂等）
export const JARGON_WORDS = Object.keys(JARGON_MAP);

// ══════════════════════════════════════════════════════════════════════
// G1 输出清理扩容（v1.4）：三类「无信息量句子」—— 补 ④⑤ 没覆盖的铺垫 / 修辞 / 跑题
//
// 来源：外部技能 i-have-adhd 的 Pre-send check 里我们缺的三类：
//   H1 空 hedge   —— 只有铺垫没有信息（「可能会…」「大概是…」「这取决于具体情况」独占一行）
//   H2 习语套话   —— 修辞代替信息（「一举两得」「手到擒来」「说白了就是」独占一行）
//   H3 侧栏跑题   —— 末尾出现的与主题无关的补白 / 联想（「顺便一提」「题外话」「扯远了」）
//
// 保守策略（刻意比 ④⑤ 更严）：三类默认只「告警」，只有整行「仅由该类别构成」
// ——抠掉该类词、行首列表标记、标点与空白后一个字都不剩——才允许进删除列表。
// 判定量是 residual = 剩下的实义字符数：
//   residual === 0            → action="remove"：整行纯套话，进 removeLines
//   0 < residual ≤ G1_WARN_MAX → action="warn"：低信息行，只记账（wouldWarn / warnLines），不动原文
//   residual > G1_WARN_MAX     → 不算命中：行里有真内容（「这可能会影响性能，需要实测」），交给人和别的判据
// 说明：最后一条是对任务书「否则只记账」的收窄 —— 含实义的长句若也逐条记账，日志会被噪音淹没。
// 阈值 G1_WARN_MAX 可调，调大 = 记更多账。
//
// 扫描范围：H1 / H2 扫全文（与 ⑤ 同口径）；H3 只扫末段（末 3 个非空行，与 ④ 同口径，
// 因为「侧栏跑题」的定义就是「末尾出现的」）。
// 与安全网 ⑦a 的关系：warn 命中不参与 ⑦a —— 否则一条 warn 会把整条消息拖去回退（见 applyOutputClean）。
// ══════════════════════════════════════════════════════════════════════

// H1 空 hedge：整行只是「可能 / 大概 / 看情况」式铺垫，不含任何具体对象或动作
export const G1_HEDGE_WORDS = CFG.g1HedgeWords;

// H2 习语套话：成语 / 口头禅代替信息，读完不知道任何事实
export const G1_IDIOM_WORDS = CFG.g1IdiomWords;

// H3 侧栏跑题：末尾补白 / 联想 / 题外话的引导语
export const G1_TANGENT_WORDS = CFG.g1TangentWords;

// 低信息阈值：抠掉该类词后剩余实义字符 ≤ 此值 → 只告警（不改原文）
export const G1_WARN_MAX = CFG.g1WarnMax;

// G1 三类（rule id 固定，日志用；tailOnly = 只扫末段）
export const G1_RULES = [
  { rule: "H1", key: "hedge", label: "空 hedge", words: G1_HEDGE_WORDS, tailOnly: false },
  { rule: "H2", key: "idiom", label: "习语套话", words: G1_IDIOM_WORDS, tailOnly: false },
  { rule: "H3", key: "tangent", label: "侧栏跑题", words: G1_TANGENT_WORDS, tailOnly: true },
];

// 命中规则的固定输出顺序（日志与 reason 都按它排）
const RULE_ORDER = ["④", "⑤", "J1", ...G1_RULES.map((d) => d.rule)];

// 状态面板用的人话标签
export const RULE_LABEL = CFG.ruleLabel;

const TAIL_RE = new RegExp(RUBRIC_TAIL_WORDS.join("|"));
const COT_RE = new RegExp(RUBRIC_COT_WORDS.join("|"));

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 长词优先排序：`说白了就是` 必须先于 `说白了` 命中，否则会剩个孤零零的「就是」而误判成 warn
const altOf = (words) => [...words].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
// 存在性测试（非 global，无 lastIndex 状态）与抠字用（global）各一份
const G1_RE = Object.fromEntries(G1_RULES.map((d) => [d.rule, new RegExp(altOf(d.words))]));
const G1_RE_G = Object.fromEntries(G1_RULES.map((d) => [d.rule, new RegExp(altOf(d.words), "g")]));
// J1 行话词：存在性测试（非 global，无 lastIndex 状态）与替换（global）各一份，共用长词优先的 altOf
const JARGON_RE = new RegExp(altOf(JARGON_WORDS));
const JARGON_RE_G = new RegExp(altOf(JARGON_WORDS), "g");

// J1 改写：把行话词换成白话。n = 替换次数；文本里没有行话词时原样返回（changed=false）。
// 最多兜 3 轮 —— 万一映射表右边又写了行话词，也不至于死循环；仍有残留就交给安全网 ⑦a 回退。
function plainOf(text) {
  const src = String(text ?? "");
  if (!JARGON_RE.test(src)) return { text: src, changed: false, n: 0 };
  let out = src;
  let n = 0;
  for (let i = 0; i < 3 && JARGON_RE.test(out); i++) {
    out = out.replace(JARGON_RE_G, (m) => {
      n++;
      return JARGON_MAP[m] ?? m;
    });
  }
  return { text: out, changed: out !== src, n };
}
// 行首列表标记 / 标题 / 引用符：先摘掉再算 residual，否则 `1. 一举两得。` 会剩个「1」而判成 warn
const LIST_MARKER_RE = /^\s*(?:\d{1,2}[.)、]\s*|#{1,6}\s+|[>*|]\s*)/;

// residual = 整行抠掉「该类词 + 行首标记 + 标点空白装饰」后剩下的实义字符
function g1Residual(line, rule) {
  const t = String(line ?? "").replace(LIST_MARKER_RE, "").replace(G1_RE_G[rule], "");
  return t.replace(NON_CONTENT_RE, "");
}

function splitLines(text) {
  return String(text == null ? "" : text).split(/\r?\n/);
}

// 非空行（保留原始行号，供 on 档按行剔除）
function nonEmptyIndexed(lines) {
  const out = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t) out.push({ i, raw, t });
  });
  return out;
}

/**
 * 对「助手刚说完的一段话」做 rubric ④⑤ + J1 行话词 + G1 三类判定（纯判定，不改任何东西；是否替换由调用方按 mode 决定）。
 * @param {string} text 该条 assistant 消息的纯文本（多个 text 块以换行拼接）
 * @param {{mode?: string, removableOnly?: boolean}} [opts]
 *   removableOnly=true 时只统计「可删」命中（G1 的 warn 一律忽略）——供安全网 ⑦a 使用
 * @returns {{ hit:boolean, rules:string[], wouldRemove:string, removeLines:string[],
 *             wouldWarn:string, warnLines:string[], warnCount:number,
 *             scanScope:string, cleaned:string|null, reason:string,
 *             hits:{rule:string,line:string,action:string}[], mode:string }}
 *   wouldRemove = 逐行「可删」命中的原文（按出现顺序，换行拼接）——即「如果要改、会被改掉的原文」
 *   removeLines = 可删命中的行（trim 后）——供 on 档按值逐行剔除
 *   wouldWarn / warnLines = G1 三类里「只告警」命中的原文 / 行（低信息行，默认不动原文，仅记账）
 *   cleaned     = 命中时整段删掉这些行后的文本（on 档参考值；on 档实际按块剔除，见 .ts）
 */
export function decideOutput(text, opts = {}) {
  const mode = String((opts || {}).mode ?? "");
  const removableOnly = opts.removableOnly === true;
  const src = String(text == null ? "" : text);
  const empty = {
    mode,
    hit: false,
    rules: [],
    wouldRemove: "",
    removeLines: [],
    wouldWarn: "",
    warnLines: [],
    warnCount: 0,
    scanScope: "末段",
    cleaned: null,
    reason: "",
    hits: [],
  };
  if (!src.trim()) return { ...empty, scanScope: "空" }; // 空文本 → 不命中

  const lines = splitLines(src);
  const ne = nonEmptyIndexed(lines);

  const allHits = [];
  // ④ 只扫末段：末尾 3 个非空行（④ 一直是「可删」）
  for (const e of ne.slice(-TAIL_SCAN_LINES)) {
    if (TAIL_RE.test(e.t)) allHits.push({ i: e.i, raw: e.raw, t: e.t, rule: "④", action: "remove" });
  }
  // ⑤ 扫全文（⑤ 一直是「可删」）
  for (const e of ne) {
    if (COT_RE.test(e.t)) allHits.push({ i: e.i, raw: e.raw, t: e.t, rule: "⑤", action: "remove" });
  }
  // J1 行话词（v1.5）扫全文。action 仍是 "remove" —— 它的代码含义是「这一行要进处理名单」；
  // 具体手术是「改写」而不是删除，落在 cleanHitLine 末尾（plainOf）。
  for (const e of ne) {
    if (JARGON_RE.test(e.t)) allHits.push({ i: e.i, raw: e.raw, t: e.t, rule: "J1", action: "remove" });
  }
  // G1（v1.4）三类：默认只告警；整行仅由该类别构成（residual=0）才允许进删除列表
  const tailIdx = new Set(ne.slice(-TAIL_SCAN_LINES).map((e) => e.i));
  for (const d of G1_RULES) {
    for (const e of ne) {
      if (d.tailOnly && !tailIdx.has(e.i)) continue; // H3 只扫末段
      if (!G1_RE[d.rule].test(e.t)) continue;
      const residual = g1Residual(e.t, d.rule).length;
      if (residual > G1_WARN_MAX) continue; // 行里有真内容 → 不算命中（既不删也不记账）
      allHits.push({
        i: e.i,
        raw: e.raw,
        t: e.t,
        rule: d.rule,
        action: residual === 0 ? "remove" : "warn",
        residual,
      });
    }
  }

  const rules = RULE_ORDER.filter((r) => allHits.some((h) => h.rule === r));
  const removableHits = allHits.filter((h) => h.action === "remove");
  if (rules.length === 0) return empty;
  if (removableOnly && removableHits.length === 0) return empty; // 只有 warn → 无「可删」命中

  // 按出现顺序排列，并按行内容（trim）去重：一行同时命中多条只算一条（remove 优先于 warn）
  allHits.sort((a, b) => a.i - b.i || (a.rule < b.rule ? -1 : 1));
  const byLine = new Map();
  for (const h of allHits) {
    const prev = byLine.get(h.t);
    if (!prev) byLine.set(h.t, { ...h });
    else if (h.action === "remove") prev.action = "remove";
  }
  const picked = [...byLine.values()];
  const pickedRemove = picked.filter((h) => h.action === "remove");
  const pickedWarn = picked.filter((h) => h.action === "warn");
  const removeIdx = new Set(pickedRemove.map((h) => h.i));

  const scopeTail = rules.some((r) => r === "④" || r === "H3");
  const scopeAll = rules.some((r) => r === "⑤" || r === "J1" || r === "H1" || r === "H2");

  return {
    mode,
    hit: true,
    rules,
    wouldRemove: pickedRemove.map((h) => h.raw).join("\n"),
    removeLines: [...new Set(pickedRemove.map((h) => h.t))],
    wouldWarn: pickedWarn.map((h) => h.raw).join("\n"),
    warnLines: [...new Set(pickedWarn.map((h) => h.t))],
    warnCount: pickedWarn.length,
    scanScope: scopeTail && scopeAll ? "末段+全文" : scopeAll ? "全文" : "末段",
    cleaned: lines.filter((_, i) => !removeIdx.has(i)).join("\n").replace(/[ \t\r\n]+$/, ""),
    reason: rules.map((r) => r + " " + (RULE_LABEL[r] || r)).join(" + "),
    hits: picked.map((h) => ({ rule: h.rule, line: h.t, action: h.action })),
  };
}

const COT_THINK_RE = new RegExp(
  "^(?:" +
    [...COT_THINK_WORDS].sort((a, b) => b.length - a.length).map(escapeRe).join("|") +
    ")[。．.！!]*$",
);

/**
 * R7（v1.7）：thinking 通道的「过渡语空转」判定（纯判定，不改东西）。
 * 与 ⑤ 的分工：⑤ 管「思维链内容泄漏进正文」（text 块）；R7 管「思维链自己在复读」。
 * 只在整行就是过渡语时命中（行首尾允许句末标点），含过渡语的正文行不碰。
 * @param {string} text thinking 块拼接文本
 * @returns {{hit:boolean, rules:string[], removeLines:string[], wouldRemove:string,
 *   hits:{rule:string,line:string,action:string}[], count:number, totalLines:number}}
 */
export function decideThinking(text) {
  const src = String(text == null ? "" : text);
  const totalLines = splitLines(src).filter((l) => l.trim()).length;
  const empty = { hit: false, rules: [], removeLines: [], wouldRemove: "", hits: [], count: 0, totalLines };
  if (!src.trim()) return empty;
  const hitRows = [];
  splitLines(src).forEach((raw, i) => {
    const t = raw.trim();
    if (t && COT_THINK_RE.test(t)) hitRows.push({ i, raw, t });
  });
  if (hitRows.length === 0) return empty;
  return {
    hit: true,
    rules: ["R7"],
    removeLines: [...new Set(hitRows.map((h) => h.t))],
    wouldRemove: hitRows.map((h) => h.raw).join("\n"),
    hits: hitRows.map((h) => ({ rule: "R7", line: h.t, action: "remove" })),
    count: hitRows.length,
    totalLines,
  };
}

/**
 * 取一条消息的 thinking 文本（content 块数组里 type=thinking 的块）。
 * 与 messageTextOf 的分工：那个取「说给用户听的话」，这个取「模型的内部草稿」。 * @param {{content?: any}} msg pi 的 AssistantMessage
 * @returns {string}
 */
export function messageThinkingOf(msg) {
  try {
    const c = msg?.content;
    if (!Array.isArray(c)) return "";
    const parts = [];
    for (const p of c) {
      if (p && p.type === "thinking" && typeof p.thinking === "string") parts.push(p.thinking);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * 取一条消息的纯文本（content 可能是 string，也可能是块数组）。
 * 只取 text 块：thinking / toolCall 不是「说给用户听的话」，不参与 ④⑤ 判定。
 * @param {{content?: any}} msg pi 的 AssistantMessage
 * @returns {string}
 */
export function messageTextOf(msg) {
  try {
    const c = msg?.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    const parts = [];
    for (const p of c) {
      if (typeof p === "string") parts.push(p);
      else if (p && p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

// ══════════════════════════════════════════════════════════════════════
// 输出清理（v1.3）：保守改写 —— 只摘「子句」，不再整行砍
//
// 为什么改：v1.2 是整行删除，命中行里只要夹着正文，正文就跟着陪葬（代价 > 收益）。
// 现在按句末标点切子句，只摘掉客套的那一小节，其余原样保留；只有剩不下东西才整行删。
// 判定语义（词表 / 阈值 / 扫描范围 / decideOutput）一行都没动 —— 本次只改「怎么清理」。
//
// 逐条规则（编号沿用交付说明）：
//   ② 命中行按 `。！？!?；;` 切子句（标点跟随前句），删掉匹配 TAIL_RE 的子句。
//      v1.5.1：J1 行话词不再走删除 —— 这条通道只给 ④ 用，J1 在 cleanHitLine 末尾改写（plainOf）。
//      TAIL_RE 由本模块 RUBRIC_TAIL_WORDS 现构造（全仓唯一来源，别处不得再抄词表）。
//   ③ 删完剩余「非标点字符」< 2 → 整行删（含 `- ` / `1. ` 这类列表标记）
//   ④ 删完剩余字符数 < 原行字符数的 40% → 不保留残缺片段，整行删
//   ⑤ 命中行位于 ``` 围栏内、或该行本身是围栏 → 跳过不处理（原文保留），记 skipped
//   ⑥ 收尾：去行首尾空白、合并重复标点（`，，`→`，`）、去悬空连接符结尾（`，、；→—:`）
//   ⑦ 安全网（任一不满足 → 整条消息回退原文，reverted:true）：
//      a. 改后全文再跑 decideOutput(..., {mode:'on'}) 必须不再命中
//      b. 改后全文 trim 后长度 ≥ 1（绝不允许把消息清成空）
//      c. 逐行比对：除命中行外，其他行必须一字不变（行数只允许因整行删除而减少）
//
// ⑤ 与 ⑦a 的交互（刻意选择）：围栏内的命中行被跳过后，全文仍会命中 → ⑦a 触发 →
// 整条消息回退原文。即「要么干净改、要么完全不碰」，不做改一半；skipped 仍会记进日志。
// ══════════════════════════════════════════════════════════════════════

const CLAUSE_END = new Set(["。", "！", "？", "!", "?", "；", ";"]);
const FENCE_RE = /^\s*(?:```|~~~)/; // 围栏行（开 / 闭都算；~~~ 一并保护，只减编辑不增风险）
const DUP_PUNCT_RE = /([，、；;：:。！？!?,.])\1+/g; // 重复标点合并（不含 …… —— ，那两个是正当用法）
const DANGLING_RE = /[，、；;：:→—]+$/; // 行尾悬空连接符
const NON_CONTENT_RE = /[\s。！？!?；;，、：:,.:\-—…·*`'"（）()\[\]【】《》<>~]/g; // 「非实质内容」字符
const PUNCT_ONLY_RE = /^[。！？!?；;]+$/; // 只由句末标点组成的子句（如连写 `？？` 的第二个）

// ② 按句末标点切子句（标点跟随前句）。
// 连写标点（`？？` / `。！`）整体归入前一个子句：否则摘掉前半句会剩个孤零零的「？」没人管。
function splitClauses(line) {
  const out = [];
  let cur = "";
  for (const ch of String(line ?? "")) {
    cur += ch;
    if (CLAUSE_END.has(ch)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  const merged = [];
  for (const c of out) {
    if (merged.length && PUNCT_ONLY_RE.test(c)) merged[merged.length - 1] += c;
    else merged.push(c);
  }
  return merged;
}

// ②③④⑥：对一行做子句级手术。
// kind='drop' → 整行删；kind='keep' → 该行保留（text 为保留内容，changed=false 表示一字未动）
function cleanHitLine(raw) {
  const clauses = splitClauses(raw);
  // ④ 客套收尾 + ⑤ 思维链泄露：同为「可删」，在子句级一起摘（标点跟随前句）
  const kept = clauses.filter((c) => !TAIL_RE.test(c) && !COT_RE.test(c));
  let t = raw;
  let changed = false;
  let rewrote = 0;
  if (kept.length !== clauses.length) {
    // ④ 客套收尾：子句级摘除（标点跟随前句 → 剩下的子句直接拼回）
    t = kept.join("").replace(/^[ \t\u00a0]+/, "").replace(/[ \t\u00a0]+$/, ""); // ⑥ 行首尾空白
    t = t.replace(DUP_PUNCT_RE, "$1").replace(DANGLING_RE, "").replace(/[ \t\u00a0]+$/, ""); // ⑥ 重复标点 / 悬空连接符
    if (t.replace(NON_CONTENT_RE, "").length < 2) return { kind: "drop", rule: "3" }; // ③ 剩不下实质内容
    if (t.length < raw.length * 0.4) return { kind: "drop", rule: "4" }; // ④ 剩不到原行 40% → 不留残片
    changed = t !== raw;
  }
  // J1 行话词：改写（不删）。放在最后 —— ④⑤ 摘过的行也要查，残留的行话词会让安全网 ⑦a 把整条消息回退。
  // （v1.7：⑤ 从「只报不改」升级为子句级摘除。旧行为是 ⑤ 命中必然 changed=false → ⑦a 回退整条，
  //   实测 279 次输出检查里 ⑤ 命中 2 次、两次都没改到 —— 那正是本次修的缺陷。）
  const plain = plainOf(t);
  if (plain.changed) {
    t = plain.text;
    changed = true;
    rewrote = plain.n;
  }
  return { kind: "keep", text: t, changed, rewrote };
}

// 单段文本（一个 text 块 / 整个 string）的子句级清理。
// 行分隔符原样搬运（\r\n 不被改成 \n）；整行删除时连它自己的行分隔符一起删。
function cleanText(text, remove, ops, opts = {}) {
  // v1.7 R7：thinking 通道命中即「整行删」——
  //   cleanHitLine 只认 ④⑤J1 的 text 词表，过渡语行在它眼里「无手术可做」，
  //   会退化成 noop → 安全网 ⑦a 判定「改了仍命中」→ 整条消息回退（实测就是这个坑）。
  const wholeLineDrop = opts && opts.wholeLineDrop === true;
  const src = String(text ?? "");
  const parts = src.split(/(\r?\n)/); // 偶数位=行，奇数位=分隔符
  const n = Math.ceil(parts.length / 2);
  const del = new Array(n).fill(false);
  const repl = new Array(n).fill(null);
  const hit = new Array(n).fill(false);
  let inFence = false;
  let skipped = 0;
  let removed = 0;
  let hits = 0;

  for (let k = 0; k < n; k++) {
    const raw = parts[2 * k] ?? "";
    const isFence = FENCE_RE.test(raw);
    if (remove.has(raw.trim())) {
      hit[k] = true;
      hits++;
      if (isFence || inFence) {
        skipped++; // ⑤ 代码围栏保护：原文保留
        ops.push({ rule: "5", line: raw, after: raw, dropped: 0, skipped: true });
      } else if (wholeLineDrop) {
        // R7：整行就是过渡语 → 连行带分隔符一起删（不做子句手术）
        del[k] = true;
        removed++;
        ops.push({ rule: "R7", line: raw, after: "", dropped: raw.length });
      } else {
        const r = cleanHitLine(raw);
        if (r.kind === "drop") {
          del[k] = true;
          removed++;
          ops.push({ rule: r.rule, line: raw, after: "", dropped: raw.length });
        } else if (r.changed) {
          repl[k] = r.text;
          ops.push({ rule: r.rewrote ? "J1" : "2", line: raw, after: r.text, dropped: raw.length - r.text.length, rewrote: r.rewrote || 0 });
        } else {
          ops.push({ rule: "2", line: raw, after: raw, dropped: 0, noop: true });
        }
      }
    }
    if (isFence) inFence = !inFence;
  }

  // 重组：保留行 + 「紧跟在它后面的那个原分隔符」（被删行的分隔符随之消失）
  let out = "";
  let prevKept = -1;
  const outLines = [];
  const outSrc = [];
  for (let k = 0; k < n; k++) {
    if (del[k]) continue;
    const txt = repl[k] === null ? parts[2 * k] ?? "" : repl[k];
    if (prevKept >= 0) out += parts[2 * prevKept + 1] ?? "\n";
    out += txt;
    outLines.push(txt);
    outSrc.push(k);
    prevKept = k;
  }

  // ⑦c 自检：除命中行外，其他行必须一字不变（用「去掉命中行后的序列」比对）
  const origOthers = [];
  for (let k = 0; k < n; k++) if (!hit[k]) origOthers.push(parts[2 * k] ?? "");
  const newOthers = outLines.filter((_, j) => !hit[outSrc[j]]);
  const othersIntact =
    origOthers.length === newOthers.length && origOthers.every((l, j) => l === newOthers[j]);

  return { text: out, removed, skipped, hits, othersIntact, ops };
}

/**
 * on 档：对消息内容做「保守改写」—— 只把命中行里客套的那一小节子句摘掉，其余原样保留
 * （保留 thinking / toolCall 块与原有分块结构）。
 * 纯函数，供单测直接调用验证「如果真改，会改成什么样」。
 *
 * 安全网（任一不满足 → 整条消息回退原文，返回的 content 与入参恒等）：
 *   ⑦a 改后全文再跑 decideOutput(..., {mode:'on'}) 必须不再命中；
 *   ⑦b 改后全文 trim 后长度 ≥ 1（绝不把消息清成空）；
 *   ⑦c 除命中行外，其他行一字不动（行数只允许因整行删除而减少）。
 *
 * @param {string|Array} content 消息 content
 * @param {string[]} removeLines decideOutput() 给出的命中行（trim 后内容）
 * @param {{detail?: boolean}} [opts] detail=true 时返回详细信息对象（默认仍返回 content 本体）
 * @returns {string|Array|{content:(string|Array), removed:number, skipped:number, reverted:boolean,
 *   from:string, to:string, revertReason:string, ops:Array}} 清理后的 content；
 *   无命中行 / 未改动时原样返回（对象恒等）。detail=true 时为信息对象：
 *   from/to = 该条消息全部 text 块以 \n 拼接前后的文本（回退时 to === from），
 *   ops = 逐行动作（rule 2/3/4/5，含 before/after/dropped 字符数），供日志与审计。
 */
export function applyOutputClean(content, removeLines, opts = {}) {
  const detail = !!(opts && opts.detail === true);
  const remove = new Set((Array.isArray(removeLines) ? removeLines : []).map((l) => String(l).trim()));
  // v1.7 R7：thinking 通道。只有显式传 includeThinking 才动 thinking 块（默认与旧版行为完全一致）。
  const includeThinking = !!(opts && opts.includeThinking === true);
  const thinkRemove = new Set(
    (Array.isArray(opts && opts.thinkLines) ? opts.thinkLines : []).map((l) => String(l).trim()),
  );
  const thinkingBlocksOf = (c) => {
    if (!Array.isArray(c)) return [];
    return c.filter((p) => p && p.type === "thinking" && typeof p.thinking === "string").map((p) => p.thinking);
  };
  const fromThink = includeThinking ? thinkingBlocksOf(content).join("\n") : "";

  const textBlocksOf = (c) => {
    if (typeof c === "string") return [c];
    if (!Array.isArray(c)) return [];
    return c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text);
  };
  const fromText = textBlocksOf(content).join("\n");
  const identity = {
    content,
    removed: 0,
    skipped: 0,
    reverted: false,
    from: fromText,
    to: fromText,
    fromThink,
    toThink: fromThink,
    revertReason: "",
    ops: [],
  };

  // 两条通道都没被点名 → 恒等（thinking 通道未开启时与旧版完全一致）
  if (remove.size === 0 && thinkRemove.size === 0) return detail ? identity : content;
  if (typeof content !== "string" && !Array.isArray(content)) return detail ? identity : content;

  const ops = [];
  let replaced = false;
  let hits = 0;
  let skipped = 0;
  let removed = 0;
  let othersIntact = true;
  const cleanOne = (text, removeSet = remove, channel = "text") => {
    const r = cleanText(text, removeSet, ops, { wholeLineDrop: channel === "think" });
    hits += r.hits;
    skipped += r.skipped;
    removed += r.removed;
    if (!r.othersIntact) othersIntact = false;
    return r.text;
  };

  let nextContent;
  if (typeof content === "string") {
    nextContent = cleanOne(content);
    replaced = nextContent !== content;
  } else {
    nextContent = content.map((p) => {
      // R7：thinking 块只在显式开启且有点名行时才动；否则原对象返回（默认行为不变）
      if (p && p.type === "thinking" && typeof p.thinking === "string") {
        if (!includeThinking || thinkRemove.size === 0) return p;
        const t = cleanOne(p.thinking, thinkRemove, "think");
        if (t === p.thinking) return p;
        replaced = true;
        return { ...p, thinking: t };
      }
      if (!(p && p.type === "text" && typeof p.text === "string")) return p; // toolCall 等其他块原对象返回
      const t = cleanOne(p.text);
      if (t === p.text) return p;
      replaced = true;
      return { ...p, text: t };
    });
    if (!replaced) nextContent = content; // 逐块没改到 → 连数组本身都保持原引用
  }

  if (hits === 0) return detail ? identity : content; // 消息里没有命中行 → 恒等（防 stale removeLines）

  const toText = (typeof nextContent === "string" ? [nextContent] : textBlocksOf(nextContent)).join("\n");
  const toThink = includeThinking ? thinkingBlocksOf(nextContent).join("\n") : "";
  // ⑦a 改后不得再命中（text 与 thinking 各自验） ⑦b 改后不得为空 ⑦c 非命中行不得被动过
  // ⑦a 只看「可删」命中（removableOnly）：G1 的 warn 命中按设计留在原文里，不该把整条消息拖去回退
  const textStillHit = decideOutput(toText, { mode: "on", removableOnly: true }).hit;
  const thinkStillHit = includeThinking && toThink.trim() ? decideThinking(toThink).hit : false;
  const revertReason = textStillHit || thinkStillHit
    ? "7a"
    : toText.trim().length < 1
      ? "7b"
      : !othersIntact
        ? "7c"
        : "";

  if (revertReason) {
    return detail ? { ...identity, skipped, ops, revertReason, reverted: true } : content; // 整条消息回退原文
  }
  return detail
    ? { content: nextContent, removed, skipped, reverted: false, from: fromText, to: toText, fromThink, toThink, revertReason: "", ops }
    : nextContent;
}
