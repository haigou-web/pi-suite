// 模拟测试 session-file-audit 扩展的核心逻辑（不启动真实 pi 会话）
// jiti 由 pi 包嵌套携带（不是本目录的依赖）。原实现用静态 import + 硬编码 npx 缓存 hash 路径，
// 缓存 hash 一变整个脚本即崩且报错难懂；此处改为动态解析并给出可诊断提示。
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child from "node:child_process";

const jitiUrl = (() => {
	const tried = [];
	try {
		return pathToFileURL(createRequire(import.meta.url).resolve("jiti")).href;
	} catch (e) {
		tried.push(`本地 node_modules 解析失败（${e.code ?? e.message}）`);
	}
	const npx = path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx");
	if (fs.existsSync(npx)) {
		for (const d of fs.readdirSync(npx)) {
			const p = path.join(
				npx,
				d,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"node_modules",
				"jiti",
				"lib",
				"jiti.mjs",
			);
			if (fs.existsSync(p)) return pathToFileURL(p).href;
		}
		tried.push(`npx 缓存（${npx}）内未找到 pi 的嵌套 jiti`);
	} else {
		tried.push(`npx 缓存目录不存在：${npx}`);
	}
	throw new Error(
		`找不到 jiti（用于加载 .ts 扩展）。已尝试：\n  - ${tried.join("\n  - ")}\n修复：在本目录 npm i -D jiti，或重装 pi 以重建缓存。`,
	);
})();

const { createJiti } = await import(jitiUrl);

const bash = (cmd) =>
	new Promise((res, rej) =>
		child.exec(cmd, (err, so, se) => (err ? rej(new Error(se || err.message)) : res({ out: so, err: se }))),
	);

const jiti = createJiti(import.meta.url);
const extPath = fileURLToPath(new URL("./index.ts", import.meta.url)); // 不再硬编码用户目录

process.env.SFA_STALE_MINUTES = "0"; // 立即视为过时，便于测试
process.env.SFA_SCAN_DEBOUNCE_MS = "50";
process.env.SFA_REVIEW_MAX_FILES = "50"; // 测试中一次送审全部候选
process.env.SFA_GUARD = "strict"; // 保护模式：默认(safe 白名单)/"0"关闭/"strict" 旧版黑名单。本节及 13 节验旧版行为（18 节验三种模式）

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfa-test-"));
fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });

// 预置 manifest：模拟「会话开始前已存在」的长期文件（birth 早于会话）
const preOld = path.join(tmp, "preexist.tmp");
fs.writeFileSync(preOld, "legacy");
const preBirth = Date.now() - 86400_000;
fs.writeFileSync(
	path.join(tmp, ".pi", "session-files.json"),
	JSON.stringify({
		[preOld]: { created: preBirth, modified: Date.now() - 60_000, writes: 1, reads: 0, size: 6, via: "tool", birth: preBirth },
	}),
);

// ---- mock ExtensionAPI ----
const handlers = {};
const commands = {};
const mockPi = {
	on: (type, fn) => ((handlers[type] ??= []).push(fn), mockPi),
	registerCommand: (name, opts) => (commands[name] = opts),
	registerTool: () => {},
};

// ---- mock ExtensionContext / UI ----
const uiCalls = { notify: [], widget: [] };
const mockCtx = {
	cwd: tmp,
	ui: {
		notify: (msg, type) => uiCalls.notify.push({ msg, type }),
		setWidget: (key, lines) => uiCalls.widget.push({ key, lines }),
		confirm: async () => false,
		select: async () => undefined,
	},
};

const factory = (await jiti.import(extPath)).default;
factory(mockPi);

const fire = async (type, event) => {
	for (const fn of handlers[type] ?? []) {
		const r = await fn(event, mockCtx);
		if (r !== undefined) return r;
	}
};
const trEvent = (toolName, input) => ({
	type: "tool_result", toolCallId: "t" + Math.random(), toolName,
	input, content: [], isError: false,
});

const fireCompactAny = () => fire("session_before_compact", { type: "session_before_compact", reason: "threshold", preparation: {} });

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${extra}`); }
};

// 1. session_start
await fire("session_start", { type: "session_start", reason: "startup" });
check("session_start 无异常", true);

// 2. write 追踪
const f1 = path.join(tmp, "report.md");
fs.writeFileSync(f1, "draft content");
await fire("tool_result", trEvent("write", { path: f1, content: "x" }));
await new Promise(r => setTimeout(r, 2000)); // 等 save timer
const manifestRaw = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "session-files.json"), "utf8"));
check("write 记录进 manifest", !!manifestRaw[f1], JSON.stringify(Object.keys(manifestRaw)));

// 3. read 标记已使用
const f2 = path.join(tmp, "used.txt");
fs.writeFileSync(f2, "hello");
await fire("tool_result", trEvent("write", { path: f2, content: "x" }));
await fire("tool_result", trEvent("read", { path: f2 }));

// 4. temp 模式文件（被读回但仍应命中规则2）
const f3 = path.join(tmp, "old.tmp");
fs.writeFileSync(f3, "temp");
await fire("tool_result", trEvent("write", { path: f3, content: "x" }));
await fire("tool_result", trEvent("read", { path: f3 }));

// 5. 版本取代：v1/v2
const v1 = path.join(tmp, "paper_v1.md");
const v2 = path.join(tmp, "paper_v2.md");
fs.writeFileSync(v1, "a"); fs.writeFileSync(v2, "b");
await fire("tool_result", trEvent("write", { path: v1 }));
await new Promise(r => setTimeout(r, 20));
await fire("tool_result", trEvent("write", { path: v2 }));

// 6. compress 触发审计 → notify + pendingInject
uiCalls.notify.length = 0;
await fireCompactAny();
check("compress 后触发 notify 提醒", uiCalls.notify.some(c => c.msg.includes("可能无用")), JSON.stringify(uiCalls.notify));
check("widget 已更新且列出可疑项", uiCalls.widget.at(-1)?.lines?.some(l => l.includes("可清理")), JSON.stringify(uiCalls.widget.at(-1)));

// 7. context 注入：默认关闭（不再在别的对话里突然冒一句提醒）；SFA_INJECT=1 才注入
const ctxResult = await fire("context", { type: "context", messages: [] });
check("默认不向上下文注入提醒", ctxResult === undefined, JSON.stringify(ctxResult));
// 连续调用也不注入
const ctxResult2 = await fire("context", { type: "context", messages: [] });
check("连续调用始终不注入", ctxResult2 === undefined);

// 8. 审计结果内容验证：f1(stale未读)、f3(temp)、v1(旧版) 应被标记；f2(已读) 不标记
const flaggedText = JSON.stringify(uiCalls.widget.at(-1)) + JSON.stringify(uiCalls.notify);
check("f1 未读→标记", flaggedText.includes("report.md"));
check("f2 已读→不标记为无用", !flaggedText.includes("used.txt"), flaggedText);
check("f3 .tmp→标记", flaggedText.includes("old.tmp"));
check("paper_v1 被新版取代→标记", flaggedText.includes("paper_v1"));

// 9. manifest 持久化包含全部追踪文件（含预置的 preexist.tmp，共 6 个）
await new Promise(r => setTimeout(r, 2000));
const m2 = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "session-files.json"), "utf8"));
check("manifest 含全部追踪文件", Object.keys(m2).length === 6 && preOld in m2, JSON.stringify(Object.keys(m2)));

// 10. 删除后审计剔除：模拟用户清理 f1
fs.rmSync(f1);
uiCalls.widget.length = 0;
await fireCompactAny(); // 再触发一次审计
const w = uiCalls.widget.at(-1);
check("已删文件从追踪中剔除", w && !JSON.stringify(w).includes("report.md"), JSON.stringify(w));

// ===== 11. 暂存删除（trash）机制 =====
const trashDir = path.join(tmp, ".trash");

// 11a. rm 拦截改写：.trash/<相对路径> 组织
const rmFile = path.join(tmp, "rm-me.txt");
fs.writeFileSync(rmFile, "doomed");
const tcId = "rmtc" + Date.now();
const callEvent = { type: "tool_call", toolCallId: tcId, toolName: "bash", input: { command: `rm ${rmFile}` } };
await fire("tool_call", callEvent);
check("rm 被改写为无害 echo（含 .trash）", callEvent.input.command.startsWith('echo "') && callEvent.input.command.includes(".trash"), callEvent.input.command);
check("改写后无 rm 执行残留", !/\brm([\s;|]|$)/.test(callEvent.input.command), callEvent.input.command);
await bash(callEvent.input.command);
check("原位置文件已消失", !fs.existsSync(rmFile));
check("文件进入 .trash/<相对路径>", fs.existsSync(path.join(trashDir, "rm-me.txt")), trashDir);
// tool_result 追加提示
const tcResult = trEvent("bash", { command: "rm" });
tcResult.toolCallId = tcId;
await fire("tool_result", tcResult);
check("tool_result 追加 [file-trash] 提示", (tcResult.content ?? []).some((c) => c.text?.includes("[file-trash]")), JSON.stringify(tcResult.content));

// 11a2. 链式命令：&& / || 场景
// rm x && rm y：两个都拦截
const cx = path.join(tmp, "chain-x.txt");
const cy = path.join(tmp, "chain-y.txt");
fs.writeFileSync(cx, "x");
fs.writeFileSync(cy, "y");
const evChain = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: `rm ${cx} && rm ${cy}` } };
await fire("tool_call", evChain);
check("链式 rm&&rm 两个都移入", !fs.existsSync(cx) && !fs.existsSync(cy) && evChain.input.command.includes("[file-trash]"), evChain.input.command);
// 非删除段保留：build 不动，rm 段被替换
const dataTmp = path.join(tmp, "data.tmp");
fs.writeFileSync(dataTmp, "d");
const evMix = { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: `build-step && rm ${dataTmp}` } };
await fire("tool_call", evMix);
check("混合链：非删除段保留+rm 段替换", evMix.input.command.startsWith("build-step && echo \"[file-trash]"), evMix.input.command);
check("混合链：data.tmp 已移入暂存", !fs.existsSync(dataTmp) && fs.existsSync(path.join(trashDir, "data.tmp")));
// 创建+删除一条链：目标解析时不存在 → 整体放行（原命令执行，创建后即删）
const evCr = { type: "tool_call", toolCallId: "c3", toolName: "bash", input: { command: `echo hi > ${path.join(tmp, "fresh.txt")} && rm ${path.join(tmp, "fresh.txt")}` } };
await fire("tool_call", evCr);
check("创建+删除同链（解析时不存在）→ 放行不改写", evCr.input.command === `echo hi > ${path.join(tmp, "fresh.txt")} && rm ${path.join(tmp, "fresh.txt")}`, evCr.input.command);
// || 链：删除段被替换，|| 语义保留
const evOr = { type: "tool_call", toolCallId: "c4", toolName: "bash", input: { command: `rm ${cx} || echo done` } };
fs.writeFileSync(cx, "x2");
await fire("tool_call", evOr);
check("|| 链：rm 段替换且含 || echo done", evOr.input.command.includes("[file-trash]") && evOr.input.command.endsWith(" || echo done"), evOr.input.command);

// 11b. 冲突：同路径再次删除 → 时间戳后缀
fs.writeFileSync(rmFile, "second");
const ev2 = { type: "tool_call", toolCallId: "t2", toolName: "bash", input: { command: `rm -f ${rmFile}` } };
await fire("tool_call", ev2);
await bash(ev2.input.command);
check("冲突时加时间戳后缀", fs.readdirSync(trashDir).some((n) => n.startsWith("rm-me.txt-") && /-20\d\d/.test(n)), JSON.stringify(fs.readdirSync(trashDir)));

// 11c. 恢复（经 /trash 命令，UI 模拟：选恢复→选第一个条目）
const rst = path.join(tmp, "restore-target.md");
fs.writeFileSync(rst, "precious");
const ev3 = { type: "tool_call", toolCallId: "t3", toolName: "bash", input: { command: `rm ${rst}` } };
await fire("tool_call", ev3);
await bash(ev3.input.command);
check("restore-target 已入暂存", fs.existsSync(path.join(trashDir, "restore-target.md")));
{
	const uiRestore = {
		...mockCtx.ui,
		select: async (title, _opts) => (title.startsWith("🗑️") ? "恢复文件" : _opts.find((o) => o.includes("restore-target.md"))),
		confirm: async () => false,
	};
	await commands.trash.handler("", { ...mockCtx, ui: uiRestore });
	check("恢复后原位置存在且内容正确", fs.existsSync(rst) && fs.readFileSync(rst, "utf8") === "precious");
}

// 11d. 恢复时覆盖分支：原位置已有新内容 → 确认覆盖后旧版夺回
const ovw = path.join(tmp, "overwrite-me.txt");
fs.writeFileSync(ovw, "old content");
const ev4 = { type: "tool_call", toolCallId: "t4", toolName: "bash", input: { command: `rm ${ovw}` } };
await fire("tool_call", ev4);
await bash(ev4.input.command);
fs.writeFileSync(ovw, "new content"); // 原位置重建
{
	const uiOverwrite = {
		...mockCtx.ui,
		select: async (title, _opts) => (title.startsWith("🗑️") ? "恢复文件" : _opts.find((o) => o.includes("overwrite-me.txt"))),
		confirm: async (title) => title.includes("目标已存在"),
	};
	await commands.trash.handler("", { ...mockCtx, ui: uiOverwrite });
	check("覆盖确认后旧版恢复到位", fs.readFileSync(ovw, "utf8") === "old content");
}

// 11e. 放行：glob / cwd 外 / 不存在
const evG = { type: "tool_call", toolCallId: "g1", toolName: "bash", input: { command: `rm *.txt` } };
await fire("tool_call", evG);
check("glob 放行不改写", evG.input.command === `rm *.txt`);
const extFile = path.join(tmp, "..", "outside.txt");
fs.writeFileSync(extFile, "x");
const evO = { type: "tool_call", toolCallId: "o1", toolName: "bash", input: { command: `rm ${extFile}` } };
await fire("tool_call", evO);
check("cwd 外目标放行", evO.input.command === `rm ${extFile}`);
const evN = { type: "tool_call", toolCallId: "n1", toolName: "bash", input: { command: `rm nope-missing.txt` } };
await fire("tool_call", evN);
check("不存在目标放行", evN.input.command === `rm nope-missing.txt`);

// 11f. 清空暂存区
{
	const uiEmpty = {
		...mockCtx.ui,
		select: async (title, _opts) => (title.startsWith("🗑️") ? "清空暂存区" : _opts[0]),
		confirm: async () => true,
	};
	await commands.trash.handler("", { ...mockCtx, ui: uiEmpty });
	const left = fs.existsSync(trashDir) ? fs.readdirSync(trashDir).length : 0;
	check("清空后暂存区无残留", left === 0, `left=${left}`);
}

// 11g. /files 多选连续处理 + 全选 + 取消跳过
{
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const gA = path.join(tmp, "gen-a.md");
	const gB = path.join(tmp, "gen-b.md");
	fs.writeFileSync(gA, "content-a");
	fs.writeFileSync(gB, "content-b");
	await sleep(30);
	await fire("tool_result", trEvent("write", { path: gA }));
	await sleep(15); // 确保 modified 时间与 audit 拉开（同毫秒时规则 1 不命中）
	await fire("tool_result", trEvent("write", { path: gB }));
	await sleep(15);
	// 连续多选：按 label 前缀匹配选 gen-a、gen-b，末尾选 ✅ 结束；
	// 列表可能含早期测试遗留文件（old.tmp 等），不依赖 flags 精确顺序。
	let sel = 0;
	let confirmCalls = 0;
	const uiMulti = {
		...mockCtx.ui,
		select: async (_t, opts) => {
			sel++;
			if (sel === 1) return opts.find((o) => o.startsWith("gen-a.md")) ?? opts[opts.length - 1];
			if (sel === 2) return opts.find((o) => o.startsWith("gen-b.md")) ?? opts[opts.length - 1];
			return opts[opts.length - 1]; // ✅ 处理完成
		},
		confirm: async () => {
			confirmCalls++;
			return true;
		},
	};
	await commands.files.handler("", { ...mockCtx, ui: uiMulti });
	check(
		"多选：连续处理两个文件均移入暂存",
		!fs.existsSync(gA) &&
			!fs.existsSync(gB) &&
			fs.existsSync(path.join(trashDir, "gen-a.md")) &&
			fs.existsSync(path.join(trashDir, "gen-b.md")),
	);
	check("多选：单文件免确认（confirm 未被调用）", confirmCalls === 0, `confirmCalls=${confirmCalls}`);

	// 全选：造 2 个新文件，select 返回 📌 全部移入暂存区
	const gC = path.join(tmp, "gen-c.md");
	const gD = path.join(tmp, "gen-d.md");
	fs.writeFileSync(gC, "content-c");
	fs.writeFileSync(gD, "content-d");
	await sleep(30);
	await fire("tool_result", trEvent("write", { path: gC }));
	await sleep(15);
	await fire("tool_result", trEvent("write", { path: gD }));
	await sleep(15);
	const uiAll = {
		...mockCtx.ui,
		select: async (_t, opts) => opts.find((o) => o.startsWith("📌")) ?? opts[opts.length - 1],
		confirm: async () => {
			confirmCalls++;
			return true;
		},
	};
	await commands.files.handler("", { ...mockCtx, ui: uiAll });
	check(
		"全选：一键全部移入暂存",
		!fs.existsSync(gC) && !fs.existsSync(gD) && fs.existsSync(path.join(trashDir, "gen-c.md")) && fs.existsSync(path.join(trashDir, "gen-d.md")),
	);
	check("全选：仅确认一次", confirmCalls === 1, `confirmCalls=${confirmCalls}`);

	// Esc 取消：不动任何文件
	const gE = path.join(tmp, "gen-e.md");
	fs.writeFileSync(gE, "content-e");
	await sleep(30);
	await fire("tool_result", trEvent("write", { path: gE }));
	await sleep(15);
	const uiCancel = {
		...mockCtx.ui,
		select: async () => undefined, // Esc
		confirm: async () => true,
	};
	await commands.files.handler("", { ...mockCtx, ui: uiCancel });
	check("取消(Esc)：不处理任何文件", fs.existsSync(gE));
}

// ===== 12. 压缩前模型复核（规则 ∩ 模型 → .trash）=====
{
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const revA = path.join(tmp, "rev-a.md");
	const revB = path.join(tmp, "rev-b.md");
	const revC = path.join(tmp, "rev-c.md");
	const revE = path.join(tmp, "rev-e.md");
	for (const [p, t] of [[revA, "a"], [revB, "b"], [revC, "c"], [revE, "e"]]) fs.writeFileSync(p, t);
	await sleep(30);
	for (const p of [revA, revB, revC, revE]) await fire("tool_result", trEvent("write", { path: p }));
	await fire("tool_result", trEvent("read", { path: revE })); // rev-e 被读回 → 不被规则标记
	await sleep(15);

	let reviewCalls = 0;
	let lastPrompt = "";
	const reviewCtx = {
		...mockCtx,
		model: { id: "mock-model" },
		modelRegistry: {
			complete: async (_model, req) => {
				reviewCalls++;
				lastPrompt = req.messages[0].content[0].text;
				return {
					content: [
						{
							type: "text",
							text: '```json\n{"clean":["rev-a.md","rev-c.md","rev-e.md"],"keep":["rev-b.md"],"note":"a/c 是旧草稿"}\n```',
						},
					],
				};
			},
		},
	};
	const fireCompact = async (ctx) => {
		for (const fn of handlers["session_before_compact"] ?? []) {
			const r = await fn({ type: "session_before_compact", reason: "threshold", preparation: {} }, ctx);
			if (r !== undefined) return r;
		}
	};

	const notifyBefore = uiCalls.notify.length;
	await fireCompact(reviewCtx);
	// 新默认：dryRun → 只出分筛结果，不动文件
	const scrPath = path.join(tmp, ".pi", "sfa-screening.json");
	const scr = JSON.parse(fs.readFileSync(scrPath, "utf8"));
	check(
		"压缩前复核（默认 dryRun）：不动任何文件",
		fs.existsSync(revA) && fs.existsSync(revC) && !fs.existsSync(path.join(trashDir, "rev-a.md")),
	);
	check(
		"分筛结果落盘：模型判定可清理项",
		scr.clean.length === 2 && scr.clean.some((i) => i.file.endsWith("rev-a.md")) && scr.clean.some((i) => i.file.endsWith("rev-c.md")),
		JSON.stringify(scr.clean),
	);
	check("压缩前复核：模型判 keep 的文件保留原位", fs.existsSync(revB) && !scr.clean.some((i) => i.file.endsWith("rev-b.md")));
	check("压缩前复核：未达规则阀值的文件不被移动", fs.existsSync(revE));
	check(
		"分筛结果落盘：模型额外怀疑项（仅记录，不自动清理）",
		scr.suspects.some((i) => i.file.endsWith("rev-e.md")),
		JSON.stringify(scr.suspects),
	);
	check(
		"压缩前复核：提示可一键集体移入",
		uiCalls.notify.slice(notifyBefore).some((n) => n.msg.includes("/files")),
		JSON.stringify(uiCalls.notify.slice(notifyBefore).map((n) => n.msg)),
	);
	check(
		"压缩前复核：送审内容含候选清单与规则理由",
		lastPrompt.includes("rev-a.md") && lastPrompt.includes("rev-b.md") && lastPrompt.includes("规则理由"),
	);

	// 用户一键流程：/files → 📋 二次分筛结果 → 📌 集体移入暂存区 → 主菜单 ✅ 完成
	let bulkSel = 0;
	let bulkConfirm = 0;
	const uiBulk = {
		...mockCtx.ui,
		select: async (_t, opts) => {
			bulkSel++;
			if (bulkSel === 1) return opts.find((o) => o.startsWith("📋")) ?? opts[opts.length - 1];
			if (bulkSel === 2) return opts.find((o) => o.startsWith("📌 集体移入")) ?? opts[opts.length - 1];
			return opts.find((o) => o.startsWith("✅")) ?? opts[opts.length - 1];
		},
		confirm: async () => {
			bulkConfirm++;
			return true;
		},
	};
	await commands.files.handler("", { ...mockCtx, ui: uiBulk });
	check(
		"/files：二次分筛结果一键集体移入暂存区",
		!fs.existsSync(revA) && !fs.existsSync(revC) && fs.existsSync(path.join(trashDir, "rev-a.md")) && fs.existsSync(path.join(trashDir, "rev-c.md")),
	);
	check("一键集体移入：仅确认一次（不含怀疑项）", bulkConfirm === 1, `bulkConfirm=${bulkConfirm}`);
	check("一键集体移入：模型怀疑项（rev-e）默认不动", fs.existsSync(revE));
	check(
		"一键集体移入后：分筛结果里的可清理项已清空",
		(() => {
			let s = { clean: [], suspects: [] };
			try {
				s = JSON.parse(fs.readFileSync(scrPath, "utf8"));
			} catch {
				return true; // 文件已删 = 也满足
			}
			return s.clean.length === 0;
		})(),
		"分筛结果仍有可清理项",
	);

	// 含怀疑项一起移入：rev-e（模型仅怀疑、规则未标记）也移入
	let sel2 = 0;
	const uiBulk2 = {
		...mockCtx.ui,
		select: async (_t, opts) => {
			sel2++;
			if (sel2 === 1) return opts.find((o) => o.startsWith("📋")) ?? opts[opts.length - 1];
			if (sel2 === 2) return opts.find((o) => o.startsWith("📌 含模型怀疑项")) ?? opts[opts.length - 1];
			return opts.find((o) => o.startsWith("✅")) ?? opts[opts.length - 1];
		},
		confirm: async () => true,
	};
	await commands.files.handler("", { ...mockCtx, ui: uiBulk2 });
	check(
		"含怀疑项集体移入：rev-e 也进暂存区",
		!fs.existsSync(revE) && fs.existsSync(path.join(trashDir, "rev-e.md")),
	);
	check("全部处理后分筛结果清空", !fs.existsSync(scrPath));

	const callsAfter1 = reviewCalls;
	await fireCompact(reviewCtx);
	check("压缩前复核：已判 keep 且未变更的文件不重复送审", reviewCalls === callsAfter1, `reviewCalls=${reviewCalls}`);

	// 模型调用失败 → 不动文件、不抛异常
	const revF = path.join(tmp, "rev-f.md");
	fs.writeFileSync(revF, "f");
	await sleep(30);
	await fire("tool_result", trEvent("write", { path: revF }));
	await sleep(15);
	await fireCompact({
		...mockCtx,
		model: { id: "m" },
		modelRegistry: {
			complete: async () => {
				throw new Error("boom");
			},
		},
	});
	check("压缩前复核：模型失败时不动文件且不抛异常", fs.existsSync(revF));

	// 无 modelRegistry → 静默跳过
	await fireCompact({ ...mockCtx });
	check("压缩前复核：无 modelRegistry 时静默跳过", true);

	// /files 中的“模型复核”选项走同一流程
	const revG = path.join(tmp, "rev-g.md");
	fs.writeFileSync(revG, "g");
	await sleep(30);
	await fire("tool_result", trEvent("write", { path: revG }));
	await sleep(15);
	let selN = 0;
	const uiReview = {
		...mockCtx.ui,
		select: async (_t, opts) => {
			selN++;
			if (selN === 1) return opts.find((o) => o.startsWith("🧠"));
			return opts.find((o) => o.startsWith("✅")) ?? opts[opts.length - 1];
		},
		confirm: async () => true,
	};
	await commands.files.handler("", {
		...mockCtx,
		ui: uiReview,
		model: { id: "m" },
		modelRegistry: {
			complete: async () => ({ content: [{ type: "text", text: '{"clean":["rev-g.md"],"keep":[]}' }] }),
		},
	});
	check("/files：模型复核选项生效（移入暂存）", !fs.existsSync(revG) && fs.existsSync(path.join(trashDir, "rev-g.md")));

	check(
		"压缩前复核：已注册 session_before_compact 钩子",
		(handlers["session_before_compact"] ?? []).length === 1,
	);
}

// ===== 13. 防误删保护（guard：保护清单 / 项目目录 / 会话前已存在 / ! 放行）=====
{
	const sleep13 = (ms) => new Promise((r) => setTimeout(r, ms));
	const fireCompact13 = async (ctx) => {
		for (const fn of handlers["session_before_compact"] ?? []) {
			const r = await fn({ type: "session_before_compact", reason: "threshold", preparation: {} }, ctx);
			if (r !== undefined) return r;
		}
	};
	const keepDir = path.join(tmp, "keepdir");
	const projDir = path.join(tmp, "proj");
	fs.mkdirSync(keepDir, { recursive: true });
	fs.mkdirSync(projDir, { recursive: true });
	fs.writeFileSync(path.join(projDir, "README.md"), "project readme");
	// 保护清单：keepdir/** 保护，但显式放行 allow.md
	fs.writeFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "# test\nkeepdir/**\n!keepdir/allow.md\n", "utf8");

	const junk = path.join(keepDir, "junk.md");
	const allow = path.join(keepDir, "allow.md");
	const nbpy = path.join(tmp, "nb.py");
	const pjunk = path.join(projDir, "junk.md");
	for (const [p, t] of [[junk, "j"], [allow, "a"], [nbpy, "print(1)"], [pjunk, "p"]]) fs.writeFileSync(p, t);
	await sleep13(30);
	for (const p of [junk, allow, nbpy, pjunk]) await fire("tool_result", trEvent("write", { path: p }));
	await sleep13(15);

	const ctx13 = {
		...mockCtx,
		model: { id: "mock-model" },
		modelRegistry: {
			complete: async () => ({
				content: [
					{
						type: "text",
						text: '{"clean":["keepdir/junk.md","keepdir/allow.md","nb.py","proj/junk.md","preexist.tmp"],"keep":[]}',
					},
				],
			}),
		},
	};
	uiCalls.notify.length = 0;
	await fireCompact13(ctx13);
	check("guard：保护清单命中 → 不自动清理", fs.existsSync(junk));
	check("guard：内置规则（*.py）→ 不自动清理", fs.existsSync(nbpy));
	check("guard：项目目录（含 README.md）→ 不自动清理", fs.existsSync(pjunk));
	check("guard：会话前已存在（预置 manifest）→ 不自动清理", fs.existsSync(preOld));
	check("guard：! 放行项进入分筛结果（未被保护）", (() => {
		const s = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "sfa-screening.json"), "utf8"));
		return s.clean.some((i) => path.basename(i.file) === path.basename(allow));
	})(), "放行项未出现在分筛结果中");
	check(
		"guard：受保护项在通知中标注 🔒",
		uiCalls.notify.some((n) => n.msg.includes("🔒")),
		JSON.stringify(uiCalls.notify.map((n) => n.msg)),
	);

	// /files：受保护项需二次确认；确认后才移动（force）
	const pjunk2 = path.join(projDir, "another.md");
	fs.writeFileSync(pjunk2, "p2");
	await sleep13(30);
	await fire("tool_result", trEvent("write", { path: pjunk2 }));
	await sleep13(15);
	let confN = 0;
	let selPhase = 0;
	const seenLabels = [];
	const filesCtx = {
		...mockCtx,
		ui: {
			...mockCtx.ui,
			select: async (_t, opts) => {
				seenLabels.push(...opts);
				if (selPhase === 0) {
					selPhase = 1;
					return opts.find((o) => o.includes("another.md"));
				}
				return opts.find((o) => o.startsWith("✅")) ?? opts[opts.length - 1];
			},
			confirm: async () => {
				confN++;
				return confN >= 2; // 第一次拒绝，第二次同意
			},
		},
	};
	await commands.files.handler("", filesCtx);
	check(
		"guard：/files 列出受保护项并标 🔒",
		seenLabels.some((l) => l.includes("another.md") && l.includes("🔒")),
		JSON.stringify(seenLabels),
	);
	check("guard：拒绝确认时不移动", fs.existsSync(pjunk2));
	selPhase = 0;
	await commands.files.handler("", filesCtx);
	check(
		"guard：确认后手动移入暂存区",
		!fs.existsSync(pjunk2) && fs.existsSync(path.join(tmp, ".trash", "proj", "another.md")),
	);

	// 安全名单入口：/files 菜单里有「📂 安全名单」，打开后给出清单路径
	let menuLabels = [];
	let panelTitle = "";
	await commands.files.handler("", {
		...mockCtx,
		ui: {
			...mockCtx.ui,
			select: async (title, opts) => {
				if (menuLabels.length === 0) {
					menuLabels = opts;
					return opts.find((o) => o.startsWith("📂"));
				}
				if (!panelTitle) panelTitle = title; // 二级面板（选目录）标题
				return undefined; // Esc
			},
		},
	});
	check("guard：/files 菜单提供安全名单入口", menuLabels.some((o) => o.startsWith("📂")), JSON.stringify(menuLabels.slice(0, 6)));
	check("guard：安全名单面板给出清单路径", panelTitle.includes("sfa-protect.txt"), panelTitle);
}

// ===== 14. /protect 命令（追加规则并立即生效）=====
{
	const sleep14 = (ms) => new Promise((r) => setTimeout(r, ms));
	const pfile = path.join(tmp, ".pi", "sfa-protect.txt");
	fs.appendFileSync(pfile, "custom-assets/**\n", "utf8");
	check("安全名单文件：手写条目写入成功", fs.readFileSync(pfile, "utf8").includes("custom-assets/**"));

	const caDir = path.join(tmp, "custom-assets");
	fs.mkdirSync(caDir, { recursive: true });
	const cj = path.join(caDir, "junk.md");
	fs.writeFileSync(cj, "x");
	await sleep14(30);
	await fire("tool_result", trEvent("write", { path: cj }));
	await sleep14(15);
	for (const fn of handlers["session_before_compact"] ?? []) {
		await fn(
			{ type: "session_before_compact", reason: "threshold", preparation: {} },
			{
				...mockCtx,
				model: { id: "mock-model" },
				modelRegistry: {
					complete: async () => ({ content: [{ type: "text", text: '{"clean":["custom-assets/junk.md"],"keep":[]}' }] }),
				},
			},
		);
	}
	check("安全名单条目立即生效（不被清理）", fs.existsSync(cj));

	// 真实场景：pi版本跟踪/ 目录（每晚定时重写的日志/状态文件）
	const vtDir = path.join(tmp, "pi版本跟踪");
	fs.mkdirSync(vtDir, { recursive: true });
	const vtLog = path.join(vtDir, "运行日志.txt");
	fs.writeFileSync(vtLog, "nightly log");
	await sleep14(30);
	await fire("tool_result", trEvent("write", { path: vtLog }));
	await sleep14(15);
	fs.appendFileSync(pfile, "pi版本跟踪/**\n", "utf8");
	for (const fn of handlers["session_before_compact"] ?? []) {
		await fn(
			{ type: "session_before_compact", reason: "threshold", preparation: {} },
			{
				...mockCtx,
				model: { id: "mock-model" },
				modelRegistry: {
					complete: async () => ({
						content: [{ type: "text", text: '{"clean":["pi版本跟踪/运行日志.txt"],"keep":[]}' }],
					}),
				},
			},
		);
	}
	check("场景：pi版本跟踪/运行日志.txt 不被清理（用户长期文件）", fs.existsSync(vtLog));

	// 项目目录自动保护（子目录含 README.md → 整目录受保护）
	const pj = path.join(tmp, "pi版本跟踪", "最新版本.md");
	fs.writeFileSync(pj, "v1");
	await sleep14(30);
	await fire("tool_result", trEvent("write", { path: pj }));
	await sleep14(15);
	const labels14 = [];
	await commands.files.handler("", {
		...mockCtx,
		ui: {
			...mockCtx.ui,
			select: async (_t, opts) => (labels14.push(...opts), undefined), // 打开列表后 Esc
		},
	});
	check(
		"/files：受保护项标注原因（🔒 + 保护清单）",
		labels14.some((l) => l.includes("最新版本.md") && l.includes("🔒")),
		JSON.stringify(labels14),
	);
}

// ===== 15. 复核失败【不得静默】+ opencode 系 provider 需注入 x-opencode-session 头 =====
{
	const sleep15 = (ms) => new Promise((r) => setTimeout(r, ms));
	const revLog = path.join(tmp, ".pi", "sfa-review.log");
	const readRevLog = () => {
		try {
			return fs.readFileSync(revLog, "utf8");
		} catch {
			return "";
		}
	};
	// 造一批「规则标记」文件（未被读回 → 规则会标）
	const mkFlagged = async (name) => {
		const p = path.join(tmp, name);
		fs.writeFileSync(p, "junk");
		await sleep15(30);
		await fire("tool_result", trEvent("write", { path: p }));
		await sleep15(15);
		return p;
	};
	// 走 /files 的 🧠 分支（用户主动触发路径）
	const runReviewViaFiles = async (ctx) => {
		uiCalls.notify.length = 0;
		let phase = 0;
		await commands.files.handler("", {
			...ctx,
			ui: {
				...mockCtx.ui,
				select: async () => (phase++ === 0 ? "🧠 模型复核并自动清理（🔒 受保护项会被跳过）" : undefined),
			},
		});
		return uiCalls.notify.map((n) => `${n.type}|${n.msg}`);
	};

	// --- 15a. 模型返回错误响应（opencode 缺 x-opencode-session 的真实失败形态）---
	const fA = await mkFlagged("revA.md");
	const errCtx = {
		...mockCtx,
		model: { provider: "acme", id: "m1" },
		modelRegistry: {
			complete: async () => ({
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: '400: {"type":"MissingSessionID"}',
			}),
		},
	};
	const msgsA = await runReviewViaFiles(errCtx);
	check("复核：模型返回 error 时给出可见提示（不静默）", msgsA.some((m) => m.includes("复核失败") && m.includes("MissingSessionID")), JSON.stringify(msgsA));
	check("复核：模型出错时不动任何文件", fs.existsSync(fA));
	check("复核：失败已写入 .pi/sfa-review.log", readRevLog().includes("MissingSessionID"));

	// --- 15b. 模型返回空内容 ---
	const fB = await mkFlagged("revB.md");
	const emptyCtx = { ...mockCtx, model: { provider: "acme", id: "m1" }, modelRegistry: { complete: async () => ({ role: "assistant", content: [] }) } };
	const msgsB = await runReviewViaFiles(emptyCtx);
	check("复核：模型返回空内容时给出可见提示", msgsB.some((m) => m.includes("空内容")), JSON.stringify(msgsB));
	check("复核：空内容时不动任何文件", fs.existsSync(fB));

	// --- 15c. 输出无法解析 ---
	const fC = await mkFlagged("revC.md");
	const badJsonCtx = { ...mockCtx, model: { provider: "acme", id: "m1" }, modelRegistry: { complete: async () => ({ content: [{ type: "text", text: "我无法回答" }] }) } };
	const msgsC = await runReviewViaFiles(badJsonCtx);
	check("复核：输出无法解析时给出可见提示", msgsC.some((m) => m.includes("无法解析")), JSON.stringify(msgsC));
	check("复核：解析失败时不动任何文件", fs.existsSync(fC));

	// --- 15d. 未执行也要说明原因（无可送审项）---
	const msgsD = await runReviewViaFiles({ ...mockCtx, model: { provider: "acme", id: "m1" }, modelRegistry: { complete: async () => ({ content: [] }) } });
	check("复核：无候选时说明原因而非沉默", msgsD.some((m) => m.includes("复核")), JSON.stringify(msgsD));

	// --- 15e. opencode 系 provider：必须带上 x-opencode-session 头，否则必然 400 ---
	await mkFlagged("revE.md");
	const seenOpts = [];
	const ocCtx = (provider, baseUrl) => ({
		...mockCtx,
		sessionManager: { getSessionId: () => "sid-1234" },
		model: { provider, id: "m1", baseUrl },
		modelRegistry: {
			complete: async (_m, _c, opts) => {
				seenOpts.push(opts);
				return { content: [{ type: "text", text: '{"clean":[],"keep":[],"note":"ok"}' }] };
			},
		},
	});
	await runReviewViaFiles(ocCtx("opencode lost", "https://opencode.ai/zen/go/v1"));
	check(
		"复核：opencode 系（自定义 provider 名 + opencode.ai baseUrl）注入 x-opencode-session",
		seenOpts.some((o) => o.headers?.["x-opencode-session"] === "sid-1234"),
		JSON.stringify(seenOpts),
	);
	seenOpts.length = 0;
	await mkFlagged("revF.md"); // 新候选（上一轮已判 keep，不会重复送审）
	await runReviewViaFiles(ocCtx("acme", "https://api.example.com/v1"));
	check(
		"复核：非 opencode provider 不注入该头",
		seenOpts.length > 0 && seenOpts.every((o) => !o.headers),
		JSON.stringify(seenOpts),
	);
}

// ===== 17. 保护面收窄：ws-* 不再是整目录豁免（防回归）=====
{
	const sleep17 = (ms) => new Promise((r) => setTimeout(r, ms));
	const fireCompact17 = async (ctx) => {
		for (const fn of handlers["session_before_compact"] ?? []) {
			const r = await fn({ type: "session_before_compact", reason: "threshold", preparation: {} }, ctx);
			if (r !== undefined) return r;
		}
	};
	// 复刻真实工程 .pi/sfa-protect.txt 的关键部分（红线B：仅按类型保留 md/yaml）
	fs.writeFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "# test\nws-*/**/*.md\nws-*/**/*.yaml\n", "utf8");
	const wsDir = path.join(tmp, "ws-20260921-0000");
	fs.mkdirSync(wsDir, { recursive: true });
	const wsJunk = path.join(wsDir, "probe-dump.jsonl"); // 会话自己的中间产物
	const wsDoc = path.join(wsDir, "笔记.md"); // 用户成果（红线B）
	const wsYaml = path.join(wsDir, "清单.yaml"); // 用户成果（红线B）
	for (const [p, t] of [[wsJunk, "{}\n"], [wsDoc, "# 笔记"], [wsYaml, "a: 1"]]) fs.writeFileSync(p, t);
	await sleep17(80);
	for (const p of [wsJunk, wsDoc, wsYaml]) await fire("tool_result", trEvent("write", { path: p }));
	await sleep17(80);

	const rel17 = (p) => path.relative(tmp, p).split(path.sep).join("/");
	const ctx17 = {
		...mockCtx,
		model: { id: "mock-model" },
		modelRegistry: {
			complete: async () => ({
				content: [{ type: "text", text: JSON.stringify({ clean: [rel17(wsJunk), rel17(wsDoc), rel17(wsYaml)], keep: [] }) }],
			}),
		},
	};
	uiCalls.notify.length = 0;
	await fireCompact17(ctx17);
	const s17 = (() => {
		try {
			return JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "sfa-screening.json"), "utf8"));
		} catch {
			return { clean: [], suspects: [], guarded: [] };
		}
	})();
	const cleanHits = (s17.clean ?? []).map((i) => String(i.file).toLowerCase());
	const guardedHits = (s17.guarded ?? []).map((x) => String(x).toLowerCase());
	check(
		"ws-*：会话中间产物（.jsonl）进入可清理分筛（不再被整目录豁免锁住）",
		cleanHits.some((x) => x.includes("probe-dump.jsonl")),
		JSON.stringify(s17.clean ?? []),
	);
	check("ws-*：用户文档 .md 仍受保护（清单类型规则）", guardedHits.some((x) => x.includes("笔记.md")));
	check("ws-*：用户数据 .yaml 仍受保护（清单类型规则）", guardedHits.some((x) => x.includes("清单.yaml")));
	check("ws-*：受保护项未被移动", fs.existsSync(wsDoc) && fs.existsSync(wsYaml));
	check(
		"ws-*：内置保护规则里不再有整目录豁免 ws-*/",
		!/^\s*["']ws-\*\/\*\*["']\s*,?\s*$/m.test(fs.readFileSync(extPath, "utf8")),
	);
}

// ===== 18. 保护模式：默认白名单（安全名单）/ 目录名单 / 排除 / 全关 / strict 黑名单 =====
{
	delete process.env.SFA_GUARD; // 默认态
	const sleep18 = (ms) => new Promise((r) => setTimeout(r, ms));
	const fireCompact18 = async (ctx) => {
		for (const fn of handlers["session_before_compact"] ?? []) {
			const r = await fn({ type: "session_before_compact", reason: "threshold", preparation: {} }, ctx);
			if (r !== undefined) return r;
		}
	};
	// 保护清单仍然写着规则（第 17 节的文件 + 内置 *.py 等），关闭时应当全部不生效
	const noGuardDir = path.join(tmp, "noguard");
	fs.mkdirSync(noGuardDir, { recursive: true });
	fs.writeFileSync(path.join(noGuardDir, "README.md"), "project marker"); // 同时构成“项目目录”
	const targets = [
		path.join(tmp, "ws-20260921-0000", "笔记.md"), // 命中清单 ws-*/**/*.md
		path.join(tmp, "guardable.py"), // 命中内置 *.py
		path.join(noGuardDir, "inner.md"), // 命中“项目目录” + README
		preOld, // 命中“会话开始前已存在”
	];
	fs.writeFileSync(path.join(tmp, "guardable.py"), "print(1)");
	fs.writeFileSync(path.join(noGuardDir, "inner.md"), "inner");
	await sleep18(80);
	for (const p of targets) await fire("tool_result", trEvent("write", { path: p }));
	await sleep18(80);

	const rel18 = (p) => path.relative(tmp, p).split(path.sep).join("/");
	const cleanExtras = []; // 让 mock 模型也把“临时新增的测试文件”列进可清理
	const ctx18 = {
		...mockCtx,
		model: { id: "mock-model" },
		modelRegistry: {
			complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ clean: [...targets, ...cleanExtras].map(rel18), keep: [] }) }] }),
		},
	};
	// 分筛清单里的路径用反斜杠（windows），比较时先归一
	const hasRel = (list, s) => list.some((x) => x.split("\\").join("/").includes(s));
	const screen18 = async () => {
		await fireCompact18(ctx18);
		const s = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "sfa-screening.json"), "utf8"));
		return { clean: (s.clean ?? []).map((i) => String(i.file).toLowerCase()), guarded: (s.guarded ?? []).map((x) => String(x).toLowerCase()) };
	};
	// 改写文件 + 补发 write 事件：让上轮分筛结论失效，确保本轮真的重跑复核（否则沿用旧结果，看到的是陈旧清单）
	const touch18 = async (paths) => {
		for (const p of paths) {
			try {
				fs.writeFileSync(p, fs.readFileSync(p, "utf8") + " ");
			} catch {
				/* ignore */
			}
			await fire("tool_result", trEvent("write", { path: p }));
		}
		await sleep18(90);
	};

	// --- 18a. 默认（白名单）模式：只保护名单里的条目 ---
	delete process.env.SFA_GUARD;
	const s18 = await screen18();
	check(
		"白名单模式：清单命中的 ws-*/**/*.md 仍受保护",
		s18.guarded.some((x) => x.includes("笔记.md")),
		JSON.stringify(s18.guarded),
	);
	check("白名单模式：未列入的内置规则 *.py 不再保护（可清理）", s18.clean.some((x) => x.includes("guardable.py")));
	check("白名单模式：项目目录不再自动整目录保护", s18.clean.some((x) => x.includes("inner.md")));
	check("白名单模式：会话开始前已存在的文件也可清理", s18.clean.some((x) => x.includes("preexist.tmp")));
	check("白名单模式：guarded 仅含安全名单命中项", s18.guarded.length === 2, JSON.stringify(s18.guarded));

	// --- 18b. 目录名单：/files → 📂 安全名单 → 下钻到目录 → 点末项切换保护 ---
	// sel 支持多级路径 "a/b"（先点 📁 a，再点 📁 b，最后点末项按钮）
	const pickSafe = async (sel, opts2 = {}) => {
		const clickToggle = opts2.clickToggle !== false;
		const parts = String(sel).split("/").filter(Boolean);
		let step = 0;
		let clicked = false;
		let sawDirStates = [];
		await commands.files.handler("", {
			...mockCtx,
			ui: {
				...mockCtx.ui,
				confirm: async () => true, // 清空名单前的确认
				select: async (_t, opts) => {
					step++;
					if (step === 1) return opts.find((o) => o.startsWith("📂"));
					sawDirStates.push(...opts.filter((o) => o.startsWith("📁") || o.startsWith("☑️") || o.startsWith("⬜") || o.startsWith("🔒 已受") || o.startsWith("🧹")));
					const next = parts[step - 2];
					if (next !== undefined) {
						const nav = opts.find((o) => o.startsWith(`📁 ${next}   `));
						if (!nav) throw new Error(`picker 里找不到子目录 ${next}，选项=${JSON.stringify(opts)}`);
						return nav;
					}
					const toggle = opts.find((o) => o.startsWith("⬜") || o.startsWith("☑️") || o.startsWith("🔒 已受") || o.startsWith("🧹"));
					if (!clickToggle || clicked) return undefined; // 不点或已点过 → Esc 退出
					clicked = true;
					if (toggle) return toggle;
					return undefined; // 再下一次 select = Esc 退出
				},
			},
		});
		return sawDirStates;
	};
	await pickSafe("noguard");
	check("目录名单：菜单选目录后写入 noguard/**", fs.readFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "utf8").includes("noguard/**"));
	const states18b2 = await pickSafe("noguard", { clickToggle: false });
	check("目录名单：已保护目录显示可取消（☑️）", states18b2.some((o) => o.startsWith("☑️")), JSON.stringify(states18b2.slice(-3)));
	const s18b = await (async () => {
		await touch18(targets);
		return screen18();
	})();
	check("目录名单：该目录内文件受保护（inner.md 转 guarded）", s18b.guarded.some((x) => x.includes("inner.md")), JSON.stringify(s18b.guarded));
	check("目录名单：目录外未列入项仍可清理", s18b.clean.some((x) => x.includes("guardable.py")));

	// --- 18c. 再点一次同一目录 = 取消保护（可清理）---
	await pickSafe("noguard");
	check(
		"取消保护：名单里已移除 noguard/**",
		!fs.readFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "utf8").includes("noguard/**"),
	);
	const s18c = await (async () => {
		await touch18(targets);
		return screen18();
	})();
	check("取消保护：inner.md 重新变为可清理", s18c.clean.some((x) => x.includes("inner.md")));

	// --- 18c2. 目录可逐级下钻：只保护子目录，不连带父目录 ---
	const deepDir = path.join(noGuardDir, "deep");
	fs.mkdirSync(deepDir, { recursive: true });
	const deepFile = path.join(deepDir, "nested.md");
	const sibFile = path.join(noGuardDir, "other.md");
	fs.writeFileSync(deepFile, "nested");
	fs.writeFileSync(sibFile, "sibling");
	cleanExtras.push(deepFile, sibFile);
	await sleep18(60);
	const states18c2 = await pickSafe("noguard/deep");
	const list18c2 = fs.readFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "utf8");
	check("下钻：子目录可单独加入名单（noguard/deep/**）", list18c2.includes("noguard/deep/**"), list18c2);
	check("下钻：父目录未被连带写入", !list18c2.split(/\r?\n/).includes("noguard/**"), list18c2);
	check("下钻：当前目录显示为可取消", states18c2.some((o) => o.startsWith("☑️")), JSON.stringify(states18c2.slice(-3)));
	await touch18([...targets, deepFile, sibFile]);
	const s18c2 = await screen18();
	check("下钻：子目录内文件受保护", hasRel(s18c2.guarded, "noguard/deep/nested.md"), JSON.stringify(s18c2.guarded));
	check("下钻：父目录其它文件仍可清理", hasRel(s18c2.clean, "noguard/other.md"), JSON.stringify(s18c2.clean));
	const states18c3 = await pickSafe("noguard", { clickToggle: false });
	check("下钻：父层列表标出子目录已保护", states18c3.some((o) => o.startsWith("📁 deep   🔒")), JSON.stringify(states18c3.slice(0, 4)));

	// --- 18c4. 根层末项「🧹 取消全部保护」：一键清空名单（保留注释）---
	const pfile18c4 = path.join(tmp, ".pi", "sfa-protect.txt");
	fs.writeFileSync(pfile18c4, fs.readFileSync(pfile18c4, "utf8") + "# 保留我\n", "utf8"); // 验证清空时注释不被误删
	const clearStates = await pickSafe("");
	check("取消全部保护：根层提供清空入口", clearStates.some((o) => o.startsWith("🧹")), JSON.stringify(clearStates.slice(-2)));
	const file18c4 = fs.readFileSync(pfile18c4, "utf8");
	const body18c4 = file18c4
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith("#"));
	check("取消全部保护：名单条目清空、注释保留", body18c4.length === 0 && file18c4.includes("# 保留我"), JSON.stringify({ body18c4, head: file18c4.slice(0, 60) }));
	// 根层不再有“一键全选保护”
	check("取消全部保护：根层不再提供一键全选保护", !clearStates.some((o) => o.startsWith("⬜")), JSON.stringify(clearStates.slice(-2)));
	await touch18([...targets, deepFile, sibFile]);
	const s18c4 = await screen18();
	check("取消全部保护：guarded 为空（不再保护任何文件）", s18c4.guarded.length === 0, JSON.stringify(s18c4.guarded));

	// --- 18d. SFA_GUARD=0：完全不保护（连安全名单也不生效）---
	process.env.SFA_GUARD = "0";
	await touch18(targets);
	const s18d = await screen18();
	check("全关模式：guarded 为空（安全名单也不生效）", s18d.guarded.length === 0, JSON.stringify(s18d.guarded));
	check("全关模式：原本受保护的 .md 也可清理", s18d.clean.some((x) => x.includes("笔记.md")));

	// --- 18e. SFA_GUARD=strict：内置规则回来（回归确认）---
	// 项目目录保护用独立目录（noguard/inner.md 已在 18c 被 ! 排除，不能复用）
	const strictDir = path.join(tmp, "strictproj");
	fs.mkdirSync(strictDir, { recursive: true });
	fs.writeFileSync(path.join(strictDir, "README.md"), "project marker");
	const strictFile = path.join(strictDir, "inner2.md");
	fs.writeFileSync(strictFile, "inner2");
	// 另造一个“strict 下不受保护”的新候选：否则候选全被保护 → 复核走“无候选”捷径，不重写分筛清单（看到的会是上轮旧结果）
	const freshFile = path.join(tmp, "strict-junk.tmp");
	fs.writeFileSync(freshFile, "junk");
	process.env.SFA_GUARD = "strict";
	await touch18([...targets, strictFile, freshFile]);
	const s18e = await screen18();
	check("strict 模式：内置 *.py 重新受保护", s18e.guarded.some((x) => x.includes("guardable.py")));
	check("strict 模式：项目目录重新受保护", s18e.guarded.some((x) => x.includes("inner2.md")), JSON.stringify(s18e.guarded));

	// --- 18f. 安全名单里的文件不进“可清理”提示（widget / notify）---
	delete process.env.SFA_GUARD;
	fs.writeFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "**\n", "utf8"); // 全部文件都在安全名单
	uiCalls.widget.length = 0;
	uiCalls.notify.length = 0;
	await touch18([...targets, deepFile, sibFile]);
	await fireCompact18(ctx18);
	await fireCompactAny(); // widget 由 compress 结果事件刷新
	const w18f = uiCalls.widget.at(-1);
	check("提示：全部文件受保护时显示“无待清理项”", w18f?.lines?.some((l) => l.includes("无待清理项")), JSON.stringify(w18f));
	check(
		"提示：受保护项折叠为一行（🔒 N 个受保护项已隐藏）",
		w18f?.lines?.some((l) => l.includes("🔒") && l.includes("已隐藏")),
		JSON.stringify(w18f),
	);
	check("提示：不再出现 ⚠️ 可清理计数", !w18f?.lines?.some((l) => l.includes("⚠️")), JSON.stringify(w18f));
	check(
		"提示：受保护文件不触发“可能无用”通知",
		!uiCalls.notify.some((n) => n.msg.includes("可能无用")),
		JSON.stringify(uiCalls.notify.map((n) => n.msg)),
	);
}

// ===== 19. junction / 软链别名：安全名单仍须命中、rm 不得被误拒 =====
{
	const jreal = path.join(tmp, "jreal");
	const jlink = path.join(tmp, "jlink");
	fs.mkdirSync(path.join(jreal, "sub"), { recursive: true });
	let linkOk = true;
	try {
		fs.symlinkSync(jreal, jlink, "junction");
	} catch {
		linkOk = false;
	}
	check("junction 创建成功（环境支持）", linkOk || fs.existsSync(jlink));

	const realFile = path.join(jreal, "sub", "data.diff");
	fs.writeFileSync(realFile, "x".repeat(32));
	const viaLink = path.join(jlink, "sub", "data.diff"); // 同一文件的 junction 别名

	// 安全名单只写真实路径形式的规则
	fs.writeFileSync(path.join(tmp, ".pi", "sfa-protect.txt"), "jreal/**\n", "utf8");
	delete process.env.SFA_GUARD; // 白名单模式

	const ctx19 = {
		...mockCtx,
		model: { id: "mock-model" },
		modelRegistry: { complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ clean: [], keep: [] }) }] }) },
	};
	const fireCompact19 = async (ctx) => {
		for (const fn of handlers["session_before_compact"] ?? []) {
			const r = await fn({ type: "session_before_compact", reason: "threshold", preparation: {} }, ctx);
			if (r !== undefined) return r;
		}
	};
	const screening19 = () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "sfa-screening.json"), "utf8"));
		} catch {
			return null;
		}
	};

	// (T1) cwd = 真实路径，文件走 junction 别名 → 仍应命中安全名单
	mockCtx.cwd = tmp;
	await fire("session_start", { type: "session_start", reason: "startup" });
	await fire("tool_result", trEvent("write", { path: viaLink }));
	await fireCompact19(ctx19);
	await fireCompactAny();
	let w19 = uiCalls.widget.at(-1);
	check("别名路径：安全名单仍命中（不进可清理列表）", !w19?.lines?.some((l) => l.includes("data.diff")), JSON.stringify(w19));
	check(
		"别名路径：受保护文件不进入送审候选",
		![
			...(screening19()?.clean ?? []),
			...(screening19()?.suspects ?? []),
		].some((i) => String(i.file).includes("data.diff")),
		JSON.stringify(screening19()),
	);

	// (T2) cwd = junction 别名，文件走真实路径 → 同样命中
	mockCtx.cwd = jlink;
	await fire("session_start", { type: "session_start", reason: "startup" });
	await fire("tool_result", trEvent("write", { path: realFile }));
	await fireCompactAny();
	w19 = uiCalls.widget.at(-1);
	check("反向别名（cwd 走 junction）：安全名单仍命中", !w19?.lines?.some((l) => l.includes("data.diff")), JSON.stringify(w19));

	// (T3) rm 走 junction 别名路径：应被识别为 cwd 内文件并移入暂存区
	mockCtx.cwd = tmp;
	await fire("session_start", { type: "session_start", reason: "startup" });
	const rmTarget = path.join(jreal, "sub", "rm-me.md");
	fs.writeFileSync(rmTarget, "z".repeat(16));
	await fire("tool_call", {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "rm19",
		input: { command: `rm "${path.join(jlink, "sub", "rm-me.md")}"` },
	});
	check("别名路径的 rm 已生效（文件已移出工作区）", !fs.existsSync(rmTarget), `still exists: ${rmTarget}`);

	mockCtx.cwd = tmp;
	// 收尾：只删 junction 本体，不动真实目录
	try {
		fs.rmdirSync(jlink);
	} catch {
		/* ignore */
	}
}

// ============ compress 工具事件（2026-10-10 新增挂钩） ============
// billion-context-pi 的 compress 工具完成后也会触发审计。
// 与 pi 内置 session_before_compact 互补：前者在压缩后、后者在压缩前。
// 放在汇总输出之前、其余用例之后，避免污染前面用例的 notifiedPaths 状态。
{
	const probe = path.join(tmp, "compress-hook-probe.txt");
	fs.writeFileSync(probe, "x");
	await fire("tool_result", trEvent("write", { path: probe }));
	uiCalls.notify.length = 0;
	await fire("tool_result", trEvent("compress", {}));
	check(
		"compress 工具事件触发审计",
		uiCalls.notify.length > 0 || uiCalls.widget.length > 0,
		`notify=${uiCalls.notify.length} widget=${uiCalls.widget.length}`,
	);
}

console.log(`\n${pass} passed, ${fail} failed. tmp=${tmp}`);
process.exit(fail ? 1 : 0);
