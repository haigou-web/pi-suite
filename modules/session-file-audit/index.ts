/**
 * session-file-audit — 会话产出文件追踪与清理提醒（零/极低 token 开销）
 *
 * 功能：
 *  - 拦截 write 工具调用，记录本会话生成的文件到本地 manifest（磁盘，不进上下文）
 *  - bash/powershell 生成的文件通过有界目录扫描捕获（mtime ≥ 会话开始时间）
 *  - read/edit 命中时标记"已使用"
 *  - 会话中途（pi 内置压缩 / billion-context-pi 的 compress 工具）触发审计：
 *      · 从未被读回且超过 staleMinutes 的文件
 *      · 临时文件模式（.tmp/.bak/~/(copy)/draft 等）
 *      · 被新版本取代的旧稿（foo_v1.md vs foo_v2.md）
 *    → 通过 widget + notify 提醒用户清理（面向用户，零 token）
 *      并可选向上下文注入一行 ≤40 token 的一次性提醒
 *
 * 命令：/files — 查看、选择性删除可疑文件（含“模型复核并自动清理”选项）
 *      /trash — 查看/恢复/清空删除暂存区（.trash）
 *
 * 压缩前模型复核（review-before-compact，SFA_REVIEW=0 关闭）：
 *  - pi 触发压缩（/compact 或自动阈值）时，先把“规则标记的可疑文件”清单交给模型独立复核
 *  - 只有【规则标记 ∩ 模型判定可清理】的文件才被移入 .trash（可 /trash restore 找回）
 *  - 模型另外怀疑、但未达规则阈值的文件仅提示，不自动清理
 *  - 模型判为保留且此后未变更的文件记入 manifest.verdict，不再重复送审（省 token）
 *  - 任何失败/超时都不阻塞压缩：退回默认压缩流程
 *    可配：SFA_REVIEW_MODEL=provider/id、SFA_REVIEW_TIMEOUT_MS、SFA_REVIEW_PREVIEW_CHARS、
 *          SFA_REVIEW_MAX_FILES、SFA_REVIEW_WATCH_MAX
 *
 * 防误删保护（guard）—— 用户只列“安全名单”，其余自由清理；三种模式由环境变量 SFA_GUARD 控制：
 *  · 不设 = **白名单模式（默认）**：只保护 <cwd>/.pi/sfa-protect.txt 里列出的条目（一个目录名 = 整个目录受保护），
 *           其余文件全部可清理；唯一的兜底是「删除一律移入 .trash，可 /trash restore 找回」。
 *           入口只有一处：/files 菜单里的「📂 安全名单：点目录加入/取消保护」，目录可逐级下钻到任意深度，
 *  · "0"   = 完全关闭保护（不保护任何文件，连安全名单也不生效）。
 *  · "strict" = 旧版三层黑名单（仅保底需要时用）：
 *      1) 内置类型规则：AGENTS.md/README.md/SKILL.md、pdf/docx/xlsx/pptx、
 *         *.py/*.ps1/*.sh/*.js/*.ts/*.json/*.yaml/*.toml/*.csv/*.db/*.service 等 + 你自己的清单
 *      2) 项目目录：文件所在子目录内出现 .git / README.md / package.json 等标记 → 整目录受保护
 *      3) 会话前已存在：文件创建时间早于本会话开始 → 视为长期文件/外部程序产出
 * 三种模式下，受保护项仍会出现在通知与 /files 列表（标 🔒），但默认只提示不移动。
 *
 * 删除暂存（soft-delete）：
 *  - 工程根建隐藏暂存区 <工程根>/.trash/<相对路径>（同名冲突时自动加时间戳）
 *  - 拦截 bash 的 rm/Remove-Item：删除动作改写为移入暂存区，可随时找回
 *  - /files 清理默认移入暂存而非永久删除；/trash restore 可原位恢复
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------- 配置（环境变量可覆盖）----------
const envNum = (k: string, d: number) => {
	const v = Number(process.env[k]);
	return Number.isFinite(v) && process.env[k] !== undefined ? v : d;
};
const CONFIG = {
	staleMinutes: envNum("SFA_STALE_MINUTES", 10), // 写后 N 分钟仍未被读回 → 可疑
	scanDepth: envNum("SFA_SCAN_DEPTH", 4), // bash 扫描目录深度上限
	scanMaxFiles: envNum("SFA_SCAN_MAX_FILES", 400), // 单次扫描新增文件数上限
	scanDebounceMs: envNum("SFA_SCAN_DEBOUNCE_MS", 3000), // bash 后延迟扫描
	manifestName: "session-files.json", // 存于 <cwd>/.pi/
	pruneDays: envNum("SFA_PRUNE_DAYS", 30), // manifest 条目保留天数
	injectReminder: process.env.SFA_INJECT === "1", // 是否向上下文注入提醒（默认关：避免在别的对话里突然冒一句）
	reviewAutoMove: process.env.SFA_REVIEW_AUTOMOVE === "1", // 压缩时是否自动移入暂存区（默认关：只出分筛结果，由用户一键集体移入）
	screeningName: "sfa-screening.json", // 二次分筛结果落盘（供 /files 一键集体移入）
	maxInjectFiles: envNum("SFA_MAX_INJECT_FILES", 5), // 注入提醒中最多列出的文件数
	trashEnabled: process.env.SFA_TRASH !== "0", // 软删除暂存开关
	trashName: ".trash", // 暂存目录名（工程根下）
	trashMaxTargets: 20, // 单次 rm 最多拦截目标数
	trashProjectDir: (cwd: string) => path.join(cwd, ".trash"), // 暂存区根目录（直接放 .trash，不再建项目同名子文件夹）
	// —— 压缩前模型复核 ——
	reviewEnabled: process.env.SFA_REVIEW !== "0", // 压缩前模型复核开关
	reviewModel: process.env.SFA_REVIEW_MODEL ?? "", // "provider/id"；空 = 用当前会话模型
	reviewTimeoutMs: envNum("SFA_REVIEW_TIMEOUT_MS", 60_000), // 单次复核超时（超时放弃，走默认压缩）
	reviewPreviewChars: envNum("SFA_REVIEW_PREVIEW_CHARS", 240), // 送审文件内容预览字符数（0=不发内容）
	reviewMaxFiles: envNum("SFA_REVIEW_MAX_FILES", 20), // 单次送审的规则标记文件上限
	reviewWatchMax: envNum("SFA_REVIEW_WATCH_MAX", 20), // 观察名单上限（仅提示，不自动清理）
	// —— 防误删保护（guard）——
	guardPreexisting: process.env.SFA_GUARD_PREEXIST !== "0", // 会话开始前已存在的文件 → 永不自动清理
	protectName: "sfa-protect.txt", // 保护清单文件名（存于 <cwd>/.pi/）
};

interface FileEntry {
	created: number;
	modified: number;
	writes: number;
	reads: number;
	lastRead?: number;
	size: number;
	via: "tool" | "scan"; // write 工具 or 目录扫描发现
	birth?: number; // 创建时间（birthtime；用于“会话前已存在”保护）
	verdict?: { at: number; modified: number; size: number; verdict: "clean" | "keep" }; // 模型复核结论
}

interface ReviewCompletion {
	content: { type: string; text?: string }[];
	usage?: unknown;
}

/** 仅用到 ctx.modelRegistry 的两个方法，避免硬依赖具体类型 */
interface ModelRegistryLike {
	find?: (provider: string, id: string) => unknown;
	complete?: (
		model: unknown,
		req: { messages: unknown[] },
		opts: Record<string, unknown>,
	) => Promise<ReviewCompletion>;
}

interface Flag {
	file: string;
	reason: string;
}

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", "__pycache__",
	".venv", "venv", ".cache", "out", ".turbo", ".nuxt",
]);
const TEMP_PATTERNS = [
	/\.(tmp|temp|bak|old|orig)$/i,
	/~$/,
	/\(copy\)\./i,
	/[-_. ]draft\d*\.(md|tex|docx)$/i,
];

/** 子目录里出现这些标记 → 视为「项目目录」，其下内容默认受保护（cwd 根本身不算） */
const PROJECT_MARKERS = [
	".git", "README.md", "AGENTS.md", "package.json", "pyproject.toml",
	"setup.py", "requirements.txt", "Makefile", "docker-compose.yml",
];

/** 内置保护 glob（相对 cwd、/ 分隔、** 跨目录）：这类文件永远不会被自动清理 */
const DEFAULT_PROTECT_GLOBS = [
	// 文档与项目标记
	"**/AGENTS.md", "**/README.md", "**/SKILL.md", "**/环境清单.md",
	// 用户文档（成品/交付物，不是会话中间产物）
	"**/*.pdf", "**/*.docx", "**/*.xlsx", "**/*.pptx",
	// 会话资料目录：没有整目录豁免（曾经有 "ws-*/**"，会把整个会话工作区锁死、
	// 导致清理功能完全失效）。ws-* 里的用户文件请在 <cwd>/.pi/sfa-protect.txt 里按需声明。
	// 脚本 / 配置 / 数据文件：天然不是“会话中间产物”
	"**/*.py", "**/*.ps1", "**/*.sh", "**/*.js", "**/*.ts", "**/*.mjs", "**/*.cjs",
	"**/*.json", "**/*.yaml", "**/*.yml", "**/*.toml", "**/*.ini", "**/*.env",
	"**/*.csv", "**/*.db", "**/*.sqlite", "**/*.lock",
	// 定时任务 / 服务定义
	"**/*.service", "**/*.timer", "**/*.plist", "**/*.cron",
];

const PROTECT_TEMPLATE = `# session-file-audit 安全名单（白名单）
# 机制：**只保护本文件里列出的条目，其余文件全可被清理**（删除先移到 .trash，可 /trash restore 找回）。
# 维护方式（唯一入口）：会话里输入 /files → 选「📂 安全名单」→ 目录可逐级下钻（点文件夹进去），
#   每层末项按钮 = 切换「当前所在目录」的保护；根目录的末项 = 清空整份名单（取消全部保护）；⬆️ 回上一级；Esc 退出。
#           也可直接编辑本文件：每行一条（目录名或 glob；! 开头 = 排除），改完立即生效。
# 模式（环境变量）：不设 = 本白名单模式；SFA_GUARD=0 = 不保护任何文件；SFA_GUARD=strict = 旧版三层黑名单。

# 下面每行 = 一个受保护项（以 # 开头的都是说明/示例，去掉 # 即生效）
# 环境清单.md
# 重要数据/
# pi版本跟踪/
# ws-*/**/*.md
`;

/** glob → 正则（支持 ** 、* 、? ；相对路径统一用 / ） */
function globToRe(glob: string): RegExp {
	let norm = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (norm.endsWith("/")) norm += "**";
	let out = "";
	for (let i = 0; i < norm.length; i++) {
		const c = norm[i];
		if (c === "*") {
			if (norm[i + 1] === "*") {
				i++;
				if (norm[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${out}$`, "i");
}

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let manifestPath = path.join(cwd, ".pi", CONFIG.manifestName);
	const manifest = new Map<string, FileEntry>();
	let sessionStartTs = Date.now();
	let scanTimer: ReturnType<typeof setTimeout> | null = null;
	let notifiedPaths = new Set<string>(); // 已通知过的路径，避免重复打扰
	// 一次性上下文提醒：走 pi 官方链路（pi.sendMessage + deliverAs:"steer"）。
	// 依据：pi 的 convertToLlm 把 custom 消息投影成 role:"user" + 内容原样（零包装），
	// 与原先手工往 context 里塞 user 消息在模型侧完全等价；差异是消息落进 session
	// （跨 resume 存活）、由 pi 自己排队，不再需要旧版那个一次性排队变量。
	// 投递点位：当前助手轮的工具调用跑完后、下一次 LLM 调用前；不传 triggerTurn → 不唤醒新轮。
	function pushContextReminder(text: string): void {
		try {
			void pi
				.sendMessage({ customType: "session-file-audit", content: text, display: true }, { deliverAs: "steer" })
				.catch(() => {
					/* 投递失败不阻断主流程 */
				});
		} catch {
			/* ignore */
		}
	}
	// 模型二次分筛结果：只落盘 + UI 展示，不写进对话上下文；由用户在 /files 里一键集体移入
	type ScreeningItem = { file: string; modified: number; size: number };
	type Screening = { at: number; clean: ScreeningItem[]; suspects: ScreeningItem[]; guarded: string[]; note?: string };
	let screening: Screening | null = null;
	const screeningPath = () => path.join(path.dirname(manifestPath), CONFIG.screeningName);
	function saveScreening(s: Screening | null) {
		screening = s;
		try {
			if (s === null) fs.rmSync(screeningPath(), { force: true });
			else {
				fs.mkdirSync(path.dirname(screeningPath()), { recursive: true });
				fs.writeFileSync(screeningPath(), JSON.stringify(s, null, 0));
			}
		} catch {
			/* 落盘失败不影响主流程 */
		}
	}
	function asItems(v: unknown): ScreeningItem[] {
		if (!Array.isArray(v)) return [];
		const out: ScreeningItem[] = [];
		for (const it of v) {
			if (typeof it === "string") out.push({ file: it, modified: 0, size: -1 });
			else if (it && typeof it === "object" && typeof (it as ScreeningItem).file === "string") {
				const o = it as ScreeningItem;
				out.push({ file: o.file, modified: o.modified ?? 0, size: o.size ?? -1 });
			}
		}
		return out;
	}
	function loadScreening() {
		try {
			const raw = JSON.parse(fs.readFileSync(screeningPath(), "utf8")) as Screening;
			if (raw && Array.isArray(raw.clean)) {
				screening = { at: raw.at ?? 0, clean: asItems(raw.clean), suspects: asItems(raw.suspects), guarded: raw.guarded ?? [], note: raw.note };
			}
		} catch {
			/* 暂无分筛结果 */
		}
	}
	function currentScreening(): Screening | null {
		if (!screening) loadScreening();
		return screening;
	}
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	const bashRewriteCount = new Map<string, number>(); // toolCallId → 移入暂存数

	// ---------- 持久化 ----------
	function scheduleSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try {
				fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
				fs.writeFileSync(
					manifestPath,
					JSON.stringify(Object.fromEntries(manifest), null, 0),
				);
			} catch {
				/* 静默失败：manifest 只是辅助数据 */
			}
		}, 1500);
	}

	function loadManifest() {
		try {
			const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, FileEntry>;
			const cutoff = Date.now() - CONFIG.pruneDays * 86400_000;
			for (const [p, e] of Object.entries(raw)) {
				if (e.modified >= cutoff) manifest.set(p, e);
			}
		} catch {
			/* 无历史记录 */
		}
	}

	// ---------- 路径归一化（junction / 符号链接） ----------
	// cwd（ctx.cwd / process.cwd）与工具传来的路径可能一个走 junction、一个走真实路径；
	// 直接用 path.relative 会得到 `..\..\...` 前缀 → 安全名单全部失效、删除被误拒。
	const realpathCache = new Map<string, string>();
	function realOf(p: string): string {
		const hit = realpathCache.get(p);
		if (hit !== undefined) return hit;
		let r = p;
		try {
			r = fs.realpathSync.native(p);
		} catch {
			try {
				r = fs.realpathSync(p);
			} catch {
				r = p;
			}
		}
		if (realpathCache.size > 4096) realpathCache.clear();
		realpathCache.set(p, r);
		return r;
	}
	/** 相对 cwd 的 posix 路径；不在 cwd 内返回 null（自动消除 junction / 软链差异） */
	function relToCwd(abs: string): string | null {
		const candidates: [string, string][] = [
			[cwd, abs],
			[realOf(cwd), realOf(abs)],
			[realOf(cwd), abs],
			[cwd, realOf(abs)],
		];
		for (const [base, target] of candidates) {
			const rel = path.relative(base, target);
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
		}
		return null;
	}

	// ---------- 追踪 ----------
	function trackWrite(absPath: string, via: FileEntry["via"]) {
		if (absPath === manifestPath) return;
		// 不追踪隐藏路径（如 .pi 内部状态）
		const rel = relToCwd(absPath) ?? path.relative(cwd, absPath);
		if (rel.split(/[\\/]/).some((seg) => seg.startsWith("."))) return;
		const now = Date.now();
		const prev = manifest.get(absPath);
		let size = 0;
		try {
			size = fs.statSync(absPath).size;
		} catch {
			return; // 文件不存在（可能被立即删除）
		}
		let birth: number | undefined;
		try {
			const bt = fs.statSync(absPath).birthtimeMs;
			birth = bt > 0 ? bt : undefined;
		} catch {
			/* ignore */
		}
		manifest.set(absPath, {
			created: prev?.created ?? now,
			modified: now,
			writes: (prev?.writes ?? 0) + 1,
			reads: prev?.reads ?? 0,
			lastRead: prev?.lastRead,
			size,
			via,
			birth: prev?.birth ?? birth,
		});
		scheduleSave();
	}

	function trackRead(absPath: string) {
		const e = manifest.get(absPath);
		if (!e) return;
		e.reads++;
		e.lastRead = Date.now();
		scheduleSave();
	}

	function toAbs(p: string): string | null {
		try {
			const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
			return path.normalize(abs);
		} catch {
			return null;
		}
	}

	// ================= 删除暂存区（.trash）=================

	/** bash 简单分词（支持单/双引号）*/
	function tokenize(cmd: string): string[] {
		const out: string[] = [];
		let cur = "";
		let inS: string | null = null;
		for (let i = 0; i < cmd.length; i++) {
			const c = cmd[i];
			if (inS) {
				if (c === inS) inS = null;
				else cur += c;
			} else if (c === "'" || c === '"') inS = c;
			else if (c === " " || c === "\t") {
				if (cur) {
					out.push(cur);
					cur = "";
				}
			} else cur += c;
		}
		if (cur) out.push(cur);
		return out;
	}

	/** bash 单引号转义 */

	const RM_ALIASES = new Set(["rm", "rmdir", "remove-item", "ri", "del"]);

	/**
	 * 解析类-rm 命令。返回目标 token 列表；不满足拦截条件返回 null（放行原命令）。
	 * 放行条件：非 rm 系命令 / 含 glob・变量・组合命令・重定向 / 目标超限。
	 */
	/**
	 * 解析类-rm 命令。返回分段结果；无删除段可拦截时返回 null（放行原命令）。
	 * 支持 && / || 链：仅处理其中的删除段，其余段原样保留。
	 * 单段跳过条件：非 rm 系 / 含 glob・危险元字符・目标超限・目标为空。
	 */
	function parseRmLike(cmd: string): { segs: string[]; ops: string[]; dels: { idx: number; targets: string[] }[] } | null {
		// 拆分链式命令并保留分隔符（&& / ||）
		const raw = cmd.split(/\s*(&&|\|\|)\s*/);
		const segs: string[] = [];
		const ops: string[] = [];
		for (let i = 0; i < raw.length; i++) {
			if (i % 2 === 0) segs.push(raw[i].trim());
			else ops.push(raw[i]);
		}
		if (segs.length === 0 || segs.every((s) => !s)) return null;
		const dels: { idx: number; targets: string[] }[] = [];
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			if (!seg) continue;
			const tokens = tokenize(seg);
			if (tokens.length === 0) continue;
			const base = path.basename(tokens[0]).toLowerCase();
			if (!RM_ALIASES.has(base)) continue; // 非删除段 → 保留
			const targets: string[] = [];
			let flagsDone = false;
			for (const t of tokens.slice(1)) {
				if (!flagsDone && (t === "--" || (t.startsWith("-") && t.length > 1))) {
					if (t === "--") flagsDone = true; // -- 之后为路径
					continue; // -r -f -R -v --preserve-root -Path -Recurse -Force 等
				}
				flagsDone = true; // 第一个非 flag 后不再跳过
				if (/[*?[\]{}]/.test(t)) {
					targets.length = 0;
					break; // glob → 本段跳过
				}
				if (/[|;&$()><`]/.test(t)) {
					targets.length = 0;
					break; // 组合/变量/重定向 → 本段跳过
				}
				targets.push(t);
			}
			if (targets.length === 0 || targets.length > CONFIG.trashMaxTargets) continue;
			dels.push({ idx: i, targets });
		}
		if (dels.length === 0) return null;
		return { segs, ops, dels };
	}

	/** 目标在 cwd 内? 返回绝对路径；否则 null（放行）*/
	function absInCwd(t: string): string | null {
		const abs = toAbs(t);
		if (!abs) return null;
		if (relToCwd(abs) === null) return null; // 不在 cwd 内 → 放行
		if (!fs.existsSync(abs)) return null; // 不存在 → 放行（rm 自然报错）
		return abs;
	}

	/** 移入暂存区，返回暂存目标路径；失败/受保护返回 null（force=true 跳过保护检查，供手动操作） */
	function moveToTrash(abs: string, force = false): string | null {
		const rel = relToCwd(abs);
		if (!rel) return null;
		if (!force) {
			const guard = protectedReason(abs);
			if (guard) {
				logDbg(`guard: 拒绝自动移动 ${rel}（${guard}）`);
				return null;
			}
		}
		const root = CONFIG.trashProjectDir(cwd);
		let dest = path.join(root, rel);
		// 同名冲突 → 加时间戳后缀
		if (fs.existsSync(dest)) {
			const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			dest += `-${ts}`;
		}
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.renameSync(abs, dest);
			manifest.delete(abs); // 移出追踪
			scheduleSave();
			return dest;
		} catch {
			return null;
		}
	}

	/** 列出暂存区内容 [{rel, abs, size, mtime}] */
	function listTrash(): { rel: string; abs: string; size: number; mtime: number }[] {
		const root = CONFIG.trashProjectDir(cwd);
		const out: { rel: string; abs: string; size: number; mtime: number }[] = [];
		const walk = (dir: string, relPrefix: string) => {
			let items: fs.Dirent[];
			try {
				items = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const it of items) {
				const p = path.join(dir, it.name);
				const rel = relPrefix ? path.join(relPrefix, it.name) : it.name;
				if (it.isDirectory()) walk(p, rel);
				else {
					let st: fs.Stats;
					try {
						st = fs.statSync(p);
					} catch {
						continue;
					}
					out.push({ rel, abs: p, size: st.size, mtime: st.mtimeMs });
				}
			}
		};
		walk(root, "");
		return out;
	}

	type RestoreResult = { ok: true; dest: string } | { ok: false; reason: "missing" | "exists" | "error" };

	/** 从暂存区恢复；冲突由 overwrite 决定 */
	function restoreFromTrash(rel: string, overwrite: boolean): RestoreResult {
		const src = path.join(CONFIG.trashProjectDir(cwd), rel);
		if (!fs.existsSync(src)) return { ok: false, reason: "missing" };
		const dest = path.join(cwd, rel);
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			if (fs.existsSync(dest)) {
				if (!overwrite) return { ok: false, reason: "exists" };
				fs.rmSync(dest, { recursive: true, force: true });
			}
			fs.renameSync(src, dest);
			// 恢复后重新登记进 manifest（视为已存在文件）
			try {
				const st = fs.statSync(dest);
				manifest.set(dest, {
					created: st.birthtimeMs, modified: Date.now(), writes: 1,
					reads: 0, size: st.size, via: "scan",
				});
			} catch {
				/* ignore */
			}
			scheduleSave();
			return { ok: true, dest };
		} catch {
			return { ok: false, reason: "error" };
		}
	}

	/** 清空暂存区 */
	function emptyTrash(): number {
		const root = CONFIG.trashProjectDir(cwd);
		if (!fs.existsSync(root)) return 0;
		const n = listTrash().length;
		fs.rmSync(root, { recursive: true, force: true });
		return n;
	}

	// ---------- 有界扫描（捕获 bash/powershell 生成的文件）----------
	function scanWorkspace(ctx: ExtensionContext) {
		let found = 0;
		const walk = (dir: string, depth: number) => {
			if (depth > CONFIG.scanDepth || found > CONFIG.scanMaxFiles) return;
			let items: fs.Dirent[];
			try {
				items = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const it of items) {
				// 跳过隐藏目录（含 .pi/.git 等）和依赖/构建目录
				if (it.name.startsWith(".") || SKIP_DIRS.has(it.name)) continue;
				const p = path.join(dir, it.name);
				if (it.isDirectory()) {
					walk(p, depth + 1);
				} else if (!manifest.has(p)) {
					let st: fs.Stats;
					try {
						st = fs.statSync(p);
					} catch {
						continue;
					}
					if (st.mtimeMs >= sessionStartTs && st.isFile()) {
						manifest.set(p, {
							created: st.birthtimeMs >= sessionStartTs ? st.birthtimeMs : st.mtimeMs,
							modified: st.mtimeMs,
							writes: 1,
							reads: 0,
							size: st.size,
							via: "scan",
							birth: st.birthtimeMs > 0 ? st.birthtimeMs : undefined,
						});
						found++;
					}
				}
			}
		};
		walk(cwd, 0);
		if (found > 0) {
			scheduleSave();
			updateWidget(ctx);
		}
	}

	function scheduleScan(ctx: ExtensionContext) {
		if (scanTimer) clearTimeout(scanTimer);
		scanTimer = setTimeout(() => {
			scanTimer = null;
			scanWorkspace(ctx);
		}, CONFIG.scanDebounceMs);
	}

	// ---------- 防误删保护（guard）----------
	let protectCache: { at: number; mode: string; mtime: number; protect: RegExp[]; allow: RegExp[] } | null = null;

	/** 保护清单路径 */
	function protectFilePath(): string {
		return path.join(path.dirname(manifestPath), CONFIG.protectName);
	}

	/** 首次使用时生成带注释的保护清单模板 */
	function ensureProtectTemplate(): string {
		const file = protectFilePath();
		if (!fs.existsSync(file)) {
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, PROTECT_TEMPLATE, "utf8");
			} catch {
				/* ignore */
			}
		}
		return file;
	}

	/** 保护模式（实时读环境变量，便于热切换）：
	 *  - "safe"（默认，白名单）：只保护 <cwd>/.pi/sfa-protect.txt 里列出的条目（整目录用 `目录/**`），其余自由清理
	 *  - "0"：完全关闭保护，任何文件都可进入候选
	 *  - "strict"：旧版三层黑名单（内置类型 + 项目目录 + 会话前已存在 + 清单）
	 */
	function guardMode(): "safe" | "off" | "strict" {
		const v = process.env.SFA_GUARD;
		if (v === "0") return "off";
		if (v === "strict") return "strict";
		return "safe";
	}
	/** 是否启用任何保护（供 UI 显示提示用） */
	const guardOn = () => guardMode() !== "off";

	/** 清单条目规整：目录（含尾 / 或实际是个目录）→ 自动补 /** 实现整目录保护 */
	function normalizeGlob(entry: string): string {
		const e = entry.replace(/\\/g, "/").replace(/\/+$/, "").trim();
		if (!e) return "";
		if (/[*?[]/.test(e)) return e;
		try {
			const abs = path.resolve(cwd, e);
			if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return `${e}/**`;
		} catch {
			/* ignore */
		}
		return e;
	}

	/** 解析保护清单（严格模式叠加内置规则；白名单模式只用清单；5s 缓存、改文件即时生效） */
	function protectRules(): { protect: RegExp[]; allow: RegExp[] } {
		const mode = guardMode();
		const file = protectFilePath();
		let mtime = 0;
		try {
			mtime = fs.statSync(file).mtimeMs;
		} catch {
			/* 清单不存在 → 白名单模式下等于不保护任何文件 */
		}
		if (protectCache && protectCache.mode === mode && protectCache.mtime === mtime && Date.now() - protectCache.at < 5000) {
			return protectCache;
		}
		const protect: string[] = mode === "strict" ? [...DEFAULT_PROTECT_GLOBS] : [];
		const allow: string[] = [];
		if (mtime > 0) {
			try {
				for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
					const line = raw.trim();
					if (!line || line.startsWith("#")) continue;
					if (line.startsWith("!")) allow.push(normalizeGlob(line.slice(1)));
					else protect.push(normalizeGlob(line));
				}
			} catch {
				/* ignore */
			}
		}
		protectCache = {
			at: Date.now(),
			mode,
			mtime,
			protect: protect.filter(Boolean).map(globToRe),
			allow: allow.filter(Boolean).map(globToRe),
		};
		return protectCache;
	}

	/** 该文件是否受保护；返回保护理由（null = 可清理）。自动清理路径一律先问这里 */
	function protectedReason(abs: string): string | null {
		// 保护模式（用户 2026-09-21 要求）：默认白名单——只保护你自己列出的安全目录/文件，
		// 其余自由清理；删除仍走 .trash 软删除可找回。SFA_GUARD=0 全关；SFA_GUARD=strict 回旧版三层黑名单。
		if (guardMode() === "off") return null;
		const posix = relToCwd(abs);
		if (!posix) return null;
		const { protect, allow } = protectRules();
		if (allow.some((re) => re.test(posix))) return null; // 显式放行优先
		if (protect.some((re) => re.test(posix))) return guardMode() === "strict" ? "保护清单命中" : "安全名单命中";
		if (guardMode() !== "strict") return null; // 白名单模式：未列入的都可自由清理
		// 项目目录保护（cwd 根本身不算）——用真实路径，避免 junction 形式不一致
		const absReal = realOf(abs);
		const cwdReal = realOf(cwd);
		for (let d = path.dirname(absReal); d.length > cwdReal.length; d = path.dirname(d)) {
			for (const mk of PROJECT_MARKERS) {
				try {
					if (fs.existsSync(path.join(d, mk))) return `项目目录 ${path.basename(d)}（含 ${mk}）`;
				} catch {
					/* ignore */
				}
			}
		}
		// 会话开始前已存在 → 长期文件 / 外部程序（如定时任务）产出
		// 例外：ws-* 会话工作区内的文件不受此保护（ws-* 就是本工具的清理范围；
		// 该目录下的用户文档由 md/yaml/清单 等类型规则与自定义保护清单兼顾）
		if (CONFIG.guardPreexisting && !/^ws-[^/]+\//i.test(posix)) {
			const e = manifest.get(abs);
			const birth = e?.birth ?? e?.created;
			if (e && birth !== undefined && birth < sessionStartTs - 1000) return "会话开始前已存在";
		}
		return null;
	}

	// ---------- 启发式审计 ----------
	function audit(): Flag[] {
		const now = Date.now();
		const flags: Flag[] = [];
		const alive: string[] = [];

		// 先剔除已不存在的文件
		for (const p of [...manifest.keys()]) {
			if (!fs.existsSync(p)) manifest.delete(p);
			else alive.push(p);
		}
		alive.sort();

		for (const p of alive) {
			const e = manifest.get(p)!;
			// 1. 从未被读回且已过时
			if (e.reads === 0 && now - e.modified > CONFIG.staleMinutes * 60_000 && e.size > 0) {
				flags.push({ file: p, reason: `生成 ${fmtAge(now - e.modified)} 未被读取` });
			}
			// 2. 临时文件模式
			else if (TEMP_PATTERNS.some((re) => re.test(path.basename(p)))) {
				flags.push({ file: p, reason: "临时/草稿命名" });
			}
			// 3. 空文件
			else if (e.size === 0 && now - e.modified > 60_000) {
				flags.push({ file: p, reason: "空文件" });
			}
		}

		// 4. 被新版本取代的旧稿：同 stem+ext 多版本，旧版标记
		const groups = new Map<string, { p: string; t: number }[]>();
		for (const p of alive) {
			const m = /^(.*?)[-_ ]?(v?\d+|final\d*|latest|new)\.(.+)$/i.exec(path.basename(p));
			if (!m) continue;
			const key = `${path.dirname(p)}\\${m[1].toLowerCase()}\\${m[3].toLowerCase()}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push({ p, t: manifest.get(p)!.modified });
		}
		for (const versions of groups.values()) {
			if (versions.length < 2) continue;
			versions.sort((a, b) => a.t - b.t);
			for (let i = 0; i < versions.length - 1; i++) {
				const v = versions[i];
				if (!flags.some((f) => f.file === v.p)) {
					flags.push({ file: v.p, reason: `已被更新版本取代（共 ${versions.length} 版）` });
				}
			}
		}

		return flags;
	}

	function fmtAge(ms: number): string {
		const m = Math.floor(ms / 60_000);
		if (m < 60) return `${m} 分钟`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h} 小时`;
		return `${Math.floor(h / 24)} 天`;
	}

	// ---------- UI ----------
	function updateWidget(ctx: ExtensionContext) {
		if (typeof ctx.ui?.setWidget !== "function") return;
		const all = audit();
		// 安全名单（🔒）里的文件永远不会被清理 → 不进“可清理”提示，只在末尾报一句数量
		const guarded = all.filter((f) => protectedReason(f.file));
		const flags = all.filter((f) => !protectedReason(f.file));
		const lines: string[] = [];
		if (flags.length === 0) {
			lines.push(`📁 已追踪 ${manifest.size} 个会话文件 · 无待清理项`);
		} else {
			lines.push(`📁 已追踪 ${manifest.size} 个会话文件 · ⚠️ ${flags.length} 个可清理：`);
			for (const f of flags.slice(0, 3)) {
				lines.push(`   ${path.basename(f.file)} — ${f.reason}`);
			}
			if (flags.length > 3) lines.push(`   …等 ${flags.length} 个（/files 查看）`);
		}
		if (guarded.length > 0) lines.push(`🔒 ${guarded.length} 个受保护项已隐藏（安全名单）`);
		// 暂存区占用（隐藏项，不参与审计）
		try {
			const n = listTrash().length;
			if (n > 0) lines.push(`🗑️ 删除暂存区 ${n} 项（/trash 找回）`);
		} catch {
			/* ignore */
		}
		try {
			ctx.ui.setWidget("session-file-audit", lines);
		} catch {
			/* UI 不可用 */
		}
		return flags;
	}

	/* 压缩前轻量审计：把「疑似无用」的文件通过 notify + 一次性上下文注入提醒用户。
	 * 零/极低 token：notify 面向用户不进上下文，注入每条会话最多一次。 */
	function auditAndRemind(ctx: ExtensionContext) {
		const flags = updateWidget(ctx) ?? [];
		const fresh = flags.filter((f) => !notifiedPaths.has(f.file));
		if (fresh.length === 0) return;

		for (const f of fresh) notifiedPaths.add(f.file);

		// 用户通知（零 token）
		if (typeof ctx.ui?.notify === "function") {
			const names = fresh
				.slice(0, 6)
				.map((f) => `${path.basename(f.file)}（${f.reason}）`)
				.join("；");
			try {
				ctx.ui.notify(
					fresh.length > 6
						? `📁 ${fresh.length} 个生成文件可能无用：${names}… 输入 /files 管理`
						: `📁 ${fresh.length} 个生成文件可能无用：${names}。输入 /files 管理`,
					"info",
				);
			} catch {
				/* ignore */
			}
		}

		// 一次性上下文注入（≤ ~40 token，仅首次）
		if (CONFIG.injectReminder) {
			const listed = fresh
				.slice(0, CONFIG.maxInjectFiles)
				.map((f) => path.basename(f.file))
				.join(", ");
			pushContextReminder(
				`[system] 本会话生成的 ${fresh.length} 个文件疑似无用，已提醒用户清理：${listed}` +
					(fresh.length > CONFIG.maxInjectFiles ? " 等" : "") +
					"。用户可用 /files 命令管理。",
			);
		}
	}

	// ---------- 事件挂钩 ----------
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.SFA_DEBUG === "1") {
			try {
				fs.appendFileSync(process.env.TEMP + "/sfa-debug-global.log", `${new Date().toISOString()} session_start cwd=${ctx.cwd}\n`);
			} catch {
				/* ignore */
			}
		}
		cwd = ctx.cwd ?? process.cwd();
		manifestPath = path.join(cwd, ".pi", CONFIG.manifestName);
		sessionStartTs = Date.now();
		notifiedPaths = new Set();
		screening = null; // 换工程目录后丢弃旧分筛清单（下次访问时重新按新 cwd 读取）
		loadManifest();
		ensureProtectTemplate();
		updateWidget(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		switch (event.toolName) {
			case "write":
			case "edit": {
				const p = toAbs(String((event.input as { path?: string }).path ?? ""));
				if (p) {
					if (event.toolName === "write") trackWrite(p, "tool");
					else trackRead(p);
				}
				break;
			}
			case "read": {
				const p = toAbs(String((event.input as { path?: string }).path ?? ""));
				if (p) trackRead(p);
				break;
			}
			case "bash":
			case "powershell": {
				// 若此调用被暂存改写，追加提示（让模型与用户都知道进了暂存区）
				const moved = bashRewriteCount.get(event.toolCallId);
				if (moved) {
					bashRewriteCount.delete(event.toolCallId);
					try {
						event.content = [
							...(event.content ?? []),
							{
								type: "text",
								text: `[file-trash] ${moved} 个文件未删除，已移入 .trash 暂存区，可用 /trash restore 找回`,
							},
						];
					} catch {
						/* 结果不可变时忽略提示 */
					}
				}
				scheduleScan(ctx);
				break;
			}
			case "compress":
				// billion-context-pi 压缩完成 → 审计 + 提醒
				auditAndRemind(ctx);
				break;
		}
	});

	/* 删除拦截：bash 的 rm/Remove-Item 改写为移入暂存区。
	 * 文件移动用 Node fs 直接做（跨 cmd/powershell/bash 一致），
	 * 原命令改写为无害的 echo（任何 shell 都能跑）。 */
	const sfaDebug = process.env.SFA_DEBUG === "1";
	const logDbg = (msg: string) => {
		if (!sfaDebug) return;
		try {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.appendFileSync(path.join(cwd, ".pi", "sfa-debug.log"), `${new Date().toISOString()} ${msg}\n`);
		} catch {
			/* ignore */
		}
	};
	pi.on("tool_call", (event) => {
		logDbg(`tool_call type=${event?.type} tool=${(event as { toolName?: string })?.toolName}`);
		if (!CONFIG.trashEnabled) return;
		if (event?.type !== "tool_call" || event.toolName !== "bash") return;
		const input = event.input as { command?: string };
		if (!input?.command) return;
		logDbg(`bash cmd seen: ${input.command}`);
		const parsed = parseRmLike(input.command);
		logDbg(`parseRmLike -> ${parsed ? parsed.segs.length + " 段, dels=" + parsed.dels.length : null} cwd=${cwd}`);
		if (!parsed) return;
		const root = CONFIG.trashProjectDir(cwd);
		const segs = [...parsed.segs];
		let total = 0;
		for (const d of parsed.dels) {
			let movedN = 0;
			const skipped: string[] = [];
			for (const t of d.targets) {
				const abs = absInCwd(t);
				if (!abs) {
					skipped.push(t);
					continue;
				}
				const rel = relToCwd(abs) ?? path.relative(cwd, abs);
				const dest = path.join(root, rel);
				const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const destFinal = fs.existsSync(dest) ? dest + "-" + ts : dest; // 冲突加时间戳
				try {
					fs.mkdirSync(path.dirname(destFinal), { recursive: true });
					fs.renameSync(abs, destFinal);
					manifest.delete(abs);
					movedN++;
				} catch {
					skipped.push(t);
				}
			}
			if (movedN > 0) {
				total += movedN;
				segs[d.idx] = `echo "[file-trash] moved ${movedN} file(s) to .trash${skipped.length > 0 ? ` (${skipped.length} untouched: ${skipped.join(" ")})` : ""} - use /trash to restore"`;
			}
		}
		if (total === 0) return; // 一个都没动 → 保持原样放行
		scheduleSave();
		bashRewriteCount.set(event.toolCallId, total);
		// 用原分隔符重建（非删除段与删除段之间的 && / || 保持不变）
		let rebuilt = segs[0];
		for (let i = 0; i < parsed.ops.length; i++) {
			rebuilt += ` ${parsed.ops[i]} ${segs[i + 1]}`;
		}
		input.command = rebuilt;
	});

	// ---------- 压缩前模型复核（review-before-compact） ----------
	/** 送审用相对路径（统一 / 分隔） */
	function relForModel(abs: string): string {
		return relToCwd(abs) ?? path.relative(cwd, abs).split(path.sep).join("/");
	}

	/** 模型返回路径 → 绝对路径 */
	function absFromModel(p: string): string | null {
		if (typeof p !== "string") return null;
		const s = p.trim().replace(/^\.\//, "").replace(/\\/g, "/");
		if (!s) return null;
		return toAbs(s);
	}

	/** 文本预览（首 N 字符；二进制/过大文件返回空串） */
	function previewOf(abs: string, chars: number): string {
		if (chars <= 0) return "";
		try {
			const st = fs.statSync(abs);
			if (st.size === 0 || st.size > 512 * 1024) return "";
			const len = Math.min(chars, st.size);
			const buf = Buffer.alloc(len);
			const fd = fs.openSync(abs, "r");
			try {
				fs.readSync(fd, buf, 0, len, 0);
			} finally {
				fs.closeSync(fd);
			}
			const text = buf.toString("utf8");
			if (text.includes("\u0000")) return "";
			return text.replace(/\s+/g, " ").trim();
		} catch {
			return "";
		}
	}

	/** 从模型输出中提取 JSON（容忍 ```json 包裹与前后废话） */
	function parseReviewJson(text: string): { clean: string[]; keep: string[]; note?: string } | null {
		const a = text.indexOf("{");
		const b = text.lastIndexOf("}");
		if (a < 0 || b <= a) return null;
		try {
			const o = JSON.parse(text.slice(a, b + 1)) as { clean?: unknown; keep?: unknown; note?: unknown };
			const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
			return { clean: arr(o.clean), keep: arr(o.keep), note: typeof o.note === "string" ? o.note : undefined };
		} catch {
			return null;
		}
	}

	/** 复核用模型：SFA_REVIEW_MODEL（provider/id）优先，否则当前会话模型 */
	function resolveReviewModel(ctx: ExtensionContext, registry?: ModelRegistryLike): unknown {
		const spec = CONFIG.reviewModel.trim();
		if (spec && registry?.find) {
			const i = spec.indexOf("/");
			const provider = i > 0 ? spec.slice(0, i) : "";
			const id = i > 0 ? spec.slice(i + 1) : spec;
			const found = id ? registry.find(provider, id) : undefined;
			if (found) return found;
			logDbg(`review: 未找到模型 ${spec}，回退当前会话模型`);
		}
		return (ctx as unknown as { model?: unknown }).model ?? null;
	}

	type ReviewResult = { candidates: number; moved: string[]; planned?: string[]; extras: string[]; note?: string; error?: string; dryRun?: boolean };

	/**
	 * 压缩前复核：规则标记的文件交模型独立判断，
	 * 只有【规则标记 ∩ 模型判定 clean】的文件才移入 .trash（可 /trash restore 找回）。
	 * 模型另外怀疑、但未达规则阀值的观察名单文件仅提示，不自动清理。
	 */
	async function reviewAndClean(
		ctx: ExtensionContext,
		signal?: AbortSignal,
		opts?: { verbose?: boolean; dryRun?: boolean },
	): Promise<ReviewResult | null> {
		const verbose = opts?.verbose === true;
		// dryRun = 只分筛、不移动文件（默认）：结果落盘并展示，由用户集体移入 .trash
		const dryRun = opts?.dryRun === true;
		const allFlags = audit();
		// 受保护项不送审、不自动清理（仅提示）
		const guarded = allFlags.filter((f) => protectedReason(f.file));
		const flags = allFlags.filter((f) => !protectedReason(f.file));
		const guardNames = guarded.slice(0, 3).map((f) => path.basename(f.file)).join("、");
		const guardTip = guarded.length > 0 ? `；🔒 跳过 ${guarded.length} 个受保护项（${guardNames}${guarded.length > 3 ? " 等" : ""}）` : "";
		const notifyGuarded = () => {
			if (guarded.length === 0) return;
			try {
				ctx.ui?.notify?.(`🔒 压缩前复核：${guarded.length} 个规则标记项已受保护、不动（${guardNames}${guarded.length > 3 ? " 等" : ""}）`, "info");
			} catch {
				/* ignore */
			}
		};
		// 未执行的每条路径都留痕（.pi/sfa-review.log），并在用户主动触发时给出原因提示
		const skip = (why: string): null => {
			logReview({ skipped: why, flags: allFlags.length, guarded: guarded.length });
			logDbg(`review: 跳过（${why}）`);
			if (verbose) {
				try {
					ctx.ui?.notify?.(`🧠 复核未执行：${why}`, "info");
				} catch {
					/* ignore */
				}
			} else {
				notifyGuarded();
			}
			return null;
		};

		if (allFlags.length === 0) return skip("本次会话没有规则标记的可疑文件");

		const registry = (ctx as unknown as { modelRegistry?: ModelRegistryLike }).modelRegistry;
		const model = resolveReviewModel(ctx, registry);
		if (!registry?.complete || !model) {
			return skip("模型不可用（ctx.model 为空或 modelRegistry.complete 缺失）");
		}

		// dryRun：上次分筛已判「可清理」且内容未变的文件直接沿用结论（不重复送审，也不会丢结果）
		const prevClean = new Map<string, ScreeningItem>();
		if (dryRun) {
			for (const it of currentScreening()?.clean ?? []) prevClean.set(it.file.toLowerCase(), it);
		}
		const carry: ScreeningItem[] = [];
		const carried = (f: Flag): boolean => {
			const it = prevClean.get(f.file.toLowerCase());
			if (!it) return false;
			const e = manifest.get(f.file);
			if (!e || e.modified !== it.modified || e.size !== it.size) return false;
			carry.push({ file: f.file, modified: e.modified, size: e.size });
			return true;
		};
		// 候选：规则标记中排除「模型曾判 keep 且此后未变更」的文件
		const cands = flags
			.filter((f) => {
				if (carried(f)) return false;
				const e = manifest.get(f.file);
				if (!e?.verdict) return true;
				return !(e.verdict.verdict === "keep" && e.verdict.modified === e.modified && e.verdict.size === e.size);
			})
			.slice(0, CONFIG.reviewMaxFiles);
		if (cands.length === 0) {
			if (carry.length > 0) {
				// 全部沿用上次分筛结论 → 不调模型，保留既有结果
				logReview({ skipped: "全部沿用上次分筛结论", flags: allFlags.length, carry: carry.length });
				logDbg(`review: 沿用上次分筛结果 ${carry.length} 项（未调用模型）`);
				return { candidates: 0, moved: [], planned: [], extras: [], dryRun };
			}
			return skip(`规则标记 ${allFlags.length} 项均已判过「保留」且内容未变（受保护 ${guarded.length} 项已被跳过）`);
		}

		const now = Date.now();
		const flaggedSet = new Set(flags.map((f) => f.file));
		// 观察名单：规则未标记、从未被读回的文件（仅供模型参考）
		const watch = [...manifest.entries()]
			.filter(([p, e]) => !flaggedSet.has(p) && e.reads === 0 && e.size > 0 && fs.existsSync(p))
			.sort((a, b) => b[1].modified - a[1].modified)
			.slice(0, CONFIG.reviewWatchMax);

		const L: string[] = [];
		L.push("你是会话文件清理复核器。下面列出本次会话生成的文件，规则引擎已将其标为“可能无用”。");
		L.push("请独立判断每个文件是否确实只是可丢弃的会话中间产物（临时文件、草稿、被取代的旧版本、从未使用的产物）。");
		L.push("必须保留：源代码与脚本、配置文件、用户手写的文档（AGENTS.md/README/笔记/清单）、数据文件，或后续步骤可能引用的文件。");
		L.push("若不确定则归入 keep（宁可保留，不可误删）。");
		L.push("只输出 JSON，不要任何解释、不要 markdown 代码块：");
		L.push('{"clean":["相对路径"],"keep":["相对路径"],"note":"一句话说明"}');
		L.push("路径必须与下面给出的相对路径完全一致（含子目录，用 / 分隔）。");
		L.push("");
		L.push(`【规则标记的文件（共 ${cands.length} 个）】`);
		cands.forEach((f, i) => {
			const e = manifest.get(f.file);
			L.push(
				`${i + 1}. ${relForModel(f.file)} — 规则理由：${f.reason}；大小：${e?.size ?? 0}B；生成于 ${fmtAge(now - (e?.modified ?? now))} 前；被读取 ${e?.reads ?? 0} 次`,
			);
			const pv = previewOf(f.file, CONFIG.reviewPreviewChars);
			if (pv) L.push(`   内容开头：${pv}`);
		});
		if (watch.length > 0) {
			L.push("");
			L.push("【观察名单（规则未标记，仅供参考，不会被自动清理）】");
			for (const [p, e] of watch) L.push(`- ${relForModel(p)}（${e.size}B，生成于 ${fmtAge(now - e.modified)} 前，从未被读取）`);
		}

		const ac = new AbortController();
		const onAbort = () => ac.abort();
		if (signal) {
			if (signal.aborted) return skip("复核被中断（压缩已取消）");
			signal.addEventListener("abort", onAbort, { once: true });
		}
		const timer = setTimeout(() => ac.abort(), CONFIG.reviewTimeoutMs);
		// opencode 系 provider 必须带 x-opencode-session 才能路由：裸 modelRegistry.complete 不会自动注入该头
		// （上游仅在 Agent.streamFn 里注入），故这里按真实 sessionId 手动补上。
		const ocHeaders = opencodeHeadersFor(model, sessionIdOf(ctx));
		let text = "";
		try {
			const res = await registry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: L.join("\n") }], timestamp: Date.now() }] },
				{ maxTokens: 1200, signal: ac.signal, cacheRetention: "none", ...(ocHeaders ? { headers: ocHeaders } : {}) },
			);
			// 模型侧错误不会抛异常，而是以 stopReason=error + errorMessage 返回（曾因此静默失败）
			const bad = res as { stopReason?: string; errorMessage?: string } | undefined;
			if (bad?.stopReason === "error" || bad?.errorMessage) {
				const msg = String(bad.errorMessage ?? "未知错误")
					.replace(/\s+/g, " ")
					.slice(0, 240);
				logDbg(`review: 模型返回错误：${msg}`);
				logReview({ error: "model", message: msg, candidates: cands.length });
				notifyReviewError(ctx, `复核失败（模型返回错误）：${msg}`, verbose);
				return { candidates: cands.length, moved: [], extras: [], error: "model", note: msg };
			}
			text = (res?.content ?? [])
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logDbg(`review: 模型调用失败/超时：${msg}`);
			logReview({ error: "model", message: msg, candidates: cands.length });
			notifyReviewError(ctx, `复核失败（模型调用出错/超时）：${msg}`, verbose);
			return { candidates: cands.length, moved: [], extras: [], error: "model", note: msg };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		if (!text.trim()) {
			logDbg("review: 模型返回空内容");
			logReview({ error: "empty", candidates: cands.length });
			notifyReviewError(ctx, "复核失败（模型返回空内容，未清理任何文件）", verbose);
			return { candidates: cands.length, moved: [], extras: [], error: "empty" };
		}

		const parsed = parseReviewJson(text);
		if (!parsed) {
			logDbg("review: 无法解析模型输出");
			logReview({ error: "parse", raw: text.slice(0, 400), candidates: cands.length });
			notifyReviewError(ctx, "复核失败（模型输出无法解析为 JSON，未清理任何文件）", verbose);
			return { candidates: cands.length, moved: [], extras: [], error: "parse", note: text.slice(0, 200) };
		}

		const candKeys = new Set(cands.map((f) => f.file.toLowerCase()));
		const cleanKeys = new Set<string>();
		for (const raw of parsed.clean) {
			const abs = absFromModel(raw);
			if (abs) cleanKeys.add(abs.toLowerCase());
		}

		// 交集：规则标记 ∩ 模型 clean → 移入暂存区（受保护项已在候选阶段剔除）
		const moved: string[] = [];
		const blocked: string[] = [];
		const planned: string[] = []; // dryRun：模型判定可清理、待用户集体移入
		for (const f of cands) {
			if (cleanKeys.has(f.file.toLowerCase())) {
				if (dryRun) {
					planned.push(f.file);
					continue;
				}
				if (moveToTrash(f.file)) {
					moved.push(f.file);
					notifiedPaths.delete(f.file);
				} else {
					blocked.push(f.file);
				}
				continue;
			}
			// 模型未确认（含明确 keep）→ 记住结论，内容未变则不再重复送审
			const e = manifest.get(f.file);
			if (e) e.verdict = { at: now, modified: e.modified, size: e.size, verdict: "keep" };
		}

		// 模型另外怀疑（未达规则阀值的已知会话文件）→ 仅提示
		const extras: string[] = [];
		const extrasAbs: string[] = [];
		for (const raw of parsed.clean) {
			const abs = absFromModel(raw);
			if (!abs) continue;
			const key = abs.toLowerCase();
			if (candKeys.has(key) || !manifest.has(abs)) continue;
			extras.push(relForModel(abs));
			extrasAbs.push(abs);
		}

		scheduleSave();
		updateWidget(ctx);
		if (dryRun) {
			// 只出分筛结果、不动文件：由用户在 /files 里一键集体移入（落盘，不写进对话上下文）
			const plannedKeys = new Set(planned.map((p) => p.toLowerCase()));
			const suspects: ScreeningItem[] = [];
			const seen = new Set<string>();
			for (const it of currentScreening()?.suspects ?? []) {
				const k = it.file.toLowerCase();
				if (seen.has(k) || plannedKeys.has(k)) continue;
				try {
					if (!fs.existsSync(it.file)) continue;
				} catch {
					continue;
				}
				seen.add(k);
				suspects.push(it);
			}
			for (const abs of extrasAbs) {
				const k = abs.toLowerCase();
				if (seen.has(k) || plannedKeys.has(k)) continue;
				seen.add(k);
				const e = manifest.get(abs);
				suspects.push({ file: abs, modified: e?.modified ?? 0, size: e?.size ?? -1 });
			}
			const cleanItems: ScreeningItem[] = [
				...carry,
				...planned.map((p) => {
					const e = manifest.get(p);
					return { file: p, modified: e?.modified ?? 0, size: e?.size ?? -1 };
				}),
			];
			saveScreening({ at: now, clean: cleanItems, suspects, guarded: guarded.map((f) => f.file), note: parsed.note });
		} else if (moved.length > 0) {
			// 自动移入模式（SFA_REVIEW_AUTOMOVE=1）：结果已落地，清掉陈旧的分筛清单避免误读
			saveScreening(null);
		}
		const names = moved.slice(0, 5).map((p) => path.basename(p)).join("、");
		try {
			if (dryRun) {
				ctx.ui?.notify?.(
					`🧠 二次分筛完成：规则标记 ${cands.length} 个 → 模型判定可清理 ${planned.length} 个${extras.length > 0 ? `，另有怀疑 ${extras.length} 个` : ""}${planned.length > 0 ? "；输入 /files 可一键集体移入暂存区" : ""}${guardTip}`,
					"info",
				);
			} else if (moved.length > 0) {
				ctx.ui?.notify?.(
					`🧠 压缩前复核：规则标记 ${cands.length} 个，模型确认可清理 ${moved.length} 个，已移入 .trash：${names}${moved.length > 5 ? " 等" : ""}（/trash restore 可找回）${guardTip}`,
					"info",
				);
				if (CONFIG.injectReminder)
					pushContextReminder(
						`[system] 压缩前清理：${moved.length} 个文件经“规则+模型”共同判定为无用，已移入 .trash（${names}${moved.length > 5 ? " 等" : ""}）。用户可用 /trash restore 找回。`,
					);
			} else {
				ctx.ui?.notify?.(`🧠 压缩前复核：模型判定 ${cands.length} 个候选文件均需保留，未做清理${guardTip}`, "info");
			}
			if (blocked.length > 0) {
				ctx.ui?.notify?.(`🔒 ${blocked.length} 个文件被保护规则拦下（未移动）：${blocked.slice(0, 3).map((p) => path.basename(p)).join("、")}`, "info");
			}
			if (extras.length > 0) {
				ctx.ui?.notify?.(
					`ℹ️ 模型另外怀疑 ${extras.length} 个未达规则阀值的文件（未自动清理，可 /files 手动处理）：${extras.slice(0, 3).join("、")}${extras.length > 3 ? " 等" : ""}`,
					"info",
				);
			}
		} catch {
			/* UI 不可用 */
		}

		logReview({ candidates: cands.length, moved, extras, guarded: guarded.map((f) => f.file), blocked, note: parsed.note, dryRun, planned: planned.length });
		return { candidates: cands.length, moved, planned, extras, note: parsed.note, dryRun };
	}

	/** 复核用模型不可用/调用失败时提示用户（压缩自动触发时 5 分钟内只提示一次，避免刷屏） */
	let reviewErrAt = 0;
	function notifyReviewError(ctx: ExtensionContext, msg: string, always: boolean) {
		try {
			const now = Date.now();
			if (!always && now - reviewErrAt < 5 * 60_000) return;
			reviewErrAt = now;
			ctx.ui?.notify?.(`🧠 ${msg}（详见 .pi/sfa-review.log）`, "error");
		} catch {
			/* UI 不可用 */
		}
	}

	function sessionIdOf(ctx: ExtensionContext): string | undefined {
		try {
			const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
			return sm?.getSessionId?.() ?? undefined;
		} catch {
			return undefined;
		}
	}

	/** opencode 系 provider 需要 x-opencode-session 头才能路由（见 reviewAndClean 内注释） */
	function opencodeHeadersFor(model: unknown, sid?: string): Record<string, string> | undefined {
		if (!sid) return undefined;
		const m = model as { provider?: string; baseUrl?: string } | undefined;
		const isOc = m?.provider === "opencode" || m?.provider === "opencode-go" || /opencode\.ai/i.test(m?.baseUrl ?? "");
		return isOc ? { "x-opencode-session": sid, "x-opencode-client": "pi" } : undefined;
	}

	/** 复核结论追加到 <cwd>/.pi/sfa-review.log（本地留痕，不占上下文） */
	function logReview(rec: Record<string, unknown>) {
		try {
			fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
			fs.appendFileSync(
				path.join(path.dirname(manifestPath), "sfa-review.log"),
				`${new Date().toISOString()} ${JSON.stringify(rec)}\n`,
			);
		} catch {
			/* ignore */
		}
	}

	/* 压缩前钩子：pi 触发压缩（/compact 或自动阀值）时先做一次“规则+模型”复核。
	 * 任何失败/超时都不阻塞压缩（返回 undefined → 走默认压缩流程）。 */
	pi.on("session_before_compact", async (event, ctx) => {
		// 轻量审计（不依赖任何第三方压缩工具）：提醒本次会话里疑似无用的生成文件
		try {
			auditAndRemind(ctx);
		} catch (err) {
			logDbg(`audit 异常（已忽略）：${err instanceof Error ? err.message : String(err)}`);
		}
		if (!CONFIG.reviewEnabled) return;
		try {
			// 默认只做二次分筛（dryRun）：结果落盘 + toast 提示，由用户在 /files 里一键集体移入
			// 设 SFA_REVIEW_AUTOMOVE=1 可恢复“自动移入暂存区”行为
			const r = await reviewAndClean(ctx, (event as { signal?: AbortSignal })?.signal, { dryRun: !CONFIG.reviewAutoMove });
			logDbg(
				`session_before_compact review -> ${r ? JSON.stringify({ c: r.candidates, moved: r.moved.length, planned: r.planned?.length ?? 0, extras: r.extras.length, dryRun: r.dryRun, err: r.error }) : "skip"}`,
			);
		} catch (err) {
			logDbg(`review 异常（已忽略）：${err instanceof Error ? err.message : String(err)}`);
		}
		return; // 不提供自定义 summary → 默认压缩继续
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (scanTimer) clearTimeout(scanTimer);
		if (saveTimer) clearTimeout(saveTimer);
		updateWidget(ctx); // 最终状态
	});

	// ---------- /files 命令 ----------
	pi.registerCommand("files", {
		description: "查看/清理本会话生成的文件",
		handler: async (_args, ctx) => {
			logDbg("command files invoked");
			const flags = audit();
			ensureProtectTemplate();
			const guardOf = (p: string) => protectedReason(p);
			const guardedFlags = flags.filter((f) => guardOf(f.file));
			if (typeof ctx.ui?.select !== "function") {
				// 无 UI 环境：打印摘要
				const summary = flags.length
					? flags.map((f) => `${path.basename(f.file)} — ${f.reason}${guardOf(f.file) ? ` 🔒${guardOf(f.file)}` : ""}`).join("\n")
					: "无";
				ctx.ui?.notify?.(`会话文件审计：追踪 ${manifest.size} 个，可清理：\n${summary}`, "info");
				return;
			}
			// 模型二次分筛结果（落盘数据，供一键集体移入；不写进对话上下文）
			const scrAlive = () => {
				const s = currentScreening();
				const empty = { clean: [] as string[], suspects: [] as string[], note: undefined as string | undefined };
				if (!s) return empty;
				const alive = (p: string) => {
					try {
						return fs.existsSync(p);
					} catch {
						return false;
					}
				};
				const clean = s.clean.map((i) => i.file).filter((p) => alive(p) && !guardOf(p));
				const suspects = s.suspects.map((i) => i.file).filter((p) => alive(p) && !guardOf(p) && !clean.includes(p));
				return { clean, suspects, note: s.note };
			};
			const dropFromScreening = (paths: string[]) => {
				const s = currentScreening();
				if (!s) return;
				const gone = new Set(paths.map((p) => p.toLowerCase()));
				const clean = s.clean.filter((i) => !gone.has(i.file.toLowerCase()));
				const suspects = s.suspects.filter((i) => !gone.has(i.file.toLowerCase()));
				saveScreening(clean.length + suspects.length === 0 ? null : { ...s, clean, suspects });
			};
			const moveMany = async (paths: string[]): Promise<string[]> => {
				const done: string[] = [];
				for (const p of paths) {
					if (moveToTrash(p)) {
						done.push(p);
						notifiedPaths.delete(p);
					}
				}
				if (done.length > 0) dropFromScreening(done);
				updateWidget(ctx);
				return done;
			};
			// 二次分筛结果专用界面：一次确认 → 集体移入暂存区（换回主菜单或单条处理）
			const showScreening = async (): Promise<void> => {
				for (;;) {
					const { clean, suspects, note } = scrAlive();
					if (clean.length === 0 && suspects.length === 0) {
						ctx.ui.notify("✅ 二次分筛结果已处理完（无可移入项）", "info");
						saveScreening(null);
						return;
					}
					const labels = [
						...(clean.length > 0 ? [`📌 集体移入暂存区（模型判定可清理 ${clean.length} 个）`] : []),
						...(suspects.length > 0 ? [`📌 含模型怀疑项一起移入（共 ${clean.length + suspects.length} 个）`] : []),
						...clean.map((p) => `✅ ${relForModel(p)} — 模型判定可清理`),
						...suspects.map((p) => `⚠️ ${relForModel(p)} — 模型仅怀疑（规则未标记）`),
						"↩️ 返回 /files 主菜单",
					];
					const picked = await ctx.ui.select(
						`🧠 二次分筛结果：可清理 ${clean.length} 个${suspects.length > 0 ? `，怀疑 ${suspects.length} 个` : ""}（移入 .trash，可 /trash restore 找回）${note ? `\n模型说明：${note}` : ""}`,
						labels,
					);
					if (picked === undefined || picked.startsWith("↩️")) return;
					if (picked.startsWith("📌 含模型怀疑项")) {
						const all = [...clean, ...suspects];
						const ok = await ctx.ui.confirm(
							"集体移入暂存区（含怀疑项）",
							`将 ${all.length} 个文件移入 .trash？\n\n含模型仅怀疑、规则未标记的 ${suspects.length} 个，请留意；可用 /trash restore 找回。`,
						);
						if (!ok) continue;
						const done = await moveMany(all);
						ctx.ui.notify(`📌 已集体移入暂存区 ${done.length} 个（/trash restore 可找回）`, "info");
						continue;
					}
					if (picked.startsWith("📌")) {
						const ok = await ctx.ui.confirm(
							"集体移入暂存区",
							`将 ${clean.length} 个模型判定可清理的文件移入 .trash？（可用 /trash restore 找回）`,
						);
						if (!ok) continue;
						const done = await moveMany(clean);
						ctx.ui.notify(`📌 已集体移入暂存区 ${done.length} 个（/trash restore 可找回）`, "info");
						continue;
					}
					const m = /^(?:✅|⚠️) (.*?) — /.exec(picked);
					if (m) {
						const abs = absFromModel(m[1]);
						if (!abs) continue;
						const done = await moveMany([abs]);
						ctx.ui.notify(
							done.length > 0 ? "已移入暂存区（/trash 找回）" : "未移动（受保护或文件已不存在）",
							done.length > 0 ? "info" : "error",
						);
					}
				}
			};
			const scr0 = scrAlive();
			const cleanableFlags = flags.filter((f) => !guardOf(f.file));
			if (cleanableFlags.length === 0 && scr0.clean.length === 0 && scr0.suspects.length === 0) {
				ctx.ui.notify(
					`已追踪 ${manifest.size} 个文件，没有可清理项 ✅${flags.length > 0 ? `（🔒 ${flags.length} 个受保护项已隐藏）` : ""}`,
					"info",
				);
				return;
			}
			// 处理单个文件：直接移入暂存区（可找回，无需确认）；永久删除走 /trash 管理
			// 受保护文件（🔒）需额外确认，并显式 force 才移动
			const moveOne = async (target: string, force: boolean): Promise<void> => {
				const d = moveToTrash(target, force);
				if (d) notifiedPaths.delete(target);
				updateWidget(ctx);
				ctx.ui.notify(d ? `已移入暂存区（/trash 找回）` : `未移动（受保护或文件已不存在）`, d ? "info" : "error");
			};
			try {
				// 循环选择：选中即移入暂存区，可连续处理多个；也可一键全部移入暂存区
				let remaining = [...flags];
				const labelOf = (f: Flag) => `${path.basename(f.file)}  [${f.reason}]${guardOf(f.file) ? `  🔒${guardOf(f.file)}` : ""}`;
				while (remaining.length > 0 || scrAlive().clean.length + scrAlive().suspects.length > 0) {
					const movable = remaining.filter((f) => !guardOf(f.file));
					const scr = scrAlive();
					const labels = [
						...(scr.clean.length + scr.suspects.length > 0
							? [`📋 二次分筛结果（可清理 ${scr.clean.length} 个）→ 一键集体移入`]
							: []),
						"🧠 模型二次分筛（调模型，只出结果清单，不自动移文件）",
						...(movable.length > 1 ? [`📌 全部移入暂存区（规则标记 ${movable.length} 个）`] : []),
						"📂 安全名单：选目录加入/取消保护（其内文件不被清理）",
						...remaining.map(labelOf),
						"✅ 处理完成",
					];
					const picked = await ctx.ui.select(
						`${remaining.length} 个疑似无用文件${scr.clean.length > 0 ? ` + 二次分筛可清理 ${scr.clean.length} 个` : ""}（Enter 移入暂存区${guardOn() ? "；🔒 = 受保护，需二次确认" : ""}；📌 全部移入）`,
						labels,
					);
					if (picked === undefined) return; // Esc / 取消
					if (picked.startsWith("📋")) {
						await showScreening();
						remaining = audit();
						continue;
					}
					if (picked.startsWith("🧠")) {
						// 交模型二次分筛：默认只出结果清单（不动文件），随后在本菜单里一键集体移入
						ctx.ui.notify("🧠 正在让模型二次分筛可疑文件…", "info");
						let r: ReviewResult | null = null;
						try {
							r = await reviewAndClean(ctx, undefined, { verbose: true, dryRun: !CONFIG.reviewAutoMove });
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							logDbg(`review(/files) 异常：${msg}`);
							logReview({ error: "throw", message: msg });
							ctx.ui.notify(`🧠 分筛异常（未移动任何文件）：${msg}（详见 .pi/sfa-review.log）`, "error");
						}
						// 未执行的各条路径已在 reviewAndClean 内单独提示原因（verbose），这里只补结果
						if (r?.error) {
							const why = r.error === "parse" ? "模型输出无法解析为 JSON" : r.error === "empty" ? "模型返回空内容" : "模型调用出错";
							ctx.ui.notify(`🧠 分筛失败（${why}），未移动任何文件${r.note ? `\n原因：${r.note}` : ""}`, "error");
						} else if (r?.dryRun) {
							if ((r.planned?.length ?? 0) > 0) {
								await showScreening();
							} else {
								ctx.ui.notify(`🧠 二次分筛完成：${r.candidates} 个候选，模型判定均需保留，没有可移入项`, "info");
							}
						} else if (r) {
							ctx.ui.notify(
								r.moved.length > 0
									? `🧠 复核完成：${r.candidates} 个候选，已移入暂存区 ${r.moved.length} 个（/trash restore 可找回）`
									: `🧠 复核完成：${r.candidates} 个候选，模型认为均需保留，未清理`,
								"info",
							);
						}
						remaining = audit(); // 复核后重新计算剩余项
						continue;
					}
					if (picked.startsWith("📂")) {
						// 安全名单入口：目录浏览器（可逐级下钻到任意深度）。每层末项 = 切换“当前目录”的保护；Esc 退出。
						const skips = new Set([CONFIG.trashName, ".pi", ".git", "node_modules", ".venv", "venv", "__pycache__"]);
						const listFile = ensureProtectTemplate();
						const readEntries = (): string[] => {
							try {
								return fs
									.readFileSync(listFile, "utf8")
									.split(/\r?\n/)
									.map((s) => s.trim())
									.filter((s) => s && !s.startsWith("#"));
							} catch {
								return [];
							}
						};
						const readAllLines = (): string[] => {
							try {
								return fs.readFileSync(listFile, "utf8").split(/\r?\n/);
							} catch {
								return [];
							}
						};
						// 目录条目识别：“dir”、“dir/”、“dir/**” 都算该目录的整目录条目
						const stripDir = (e: string) => e.replace(/^!/, "").replace(/\/+$/, "").replace(/\/\*\*$/, "");
						const shownDir = (rel: string) => (rel ? `${rel}/` : "本工程根目录（全部文件）");
						// 是否已被保护：用探针文件判定，从而祖先条目（如 ws-*/**、dir/**）也能命中
						const isCovered = (rel: string) => protectedReason(path.join(cwd, rel, "__sfa_probe__")) !== null;
						let browse = "";
						for (;;) {
							const entries = readEntries();
							const hasOwn = browse !== "" && entries.some((e) => !e.startsWith("!") && stripDir(e) === browse);
							let subdirs: string[] = [];
							try {
								subdirs = fs
									.readdirSync(path.join(cwd, browse), { withFileTypes: true })
									.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !skips.has(d.name))
									.map((d) => d.name)
									.sort();
							} catch {
								/* ignore */
							}
							const labels2 = subdirs.map((n) => {
								const child = browse ? `${browse}/${n}` : n;
								const own = entries.some((e) => !e.startsWith("!") && stripDir(e) === child);
								return `📁 ${n}   ${own ? "🔒 已保护" : isCovered(child) ? "🔒 由上级保护" : "· 未保护"}`;
							});
							if (browse === "") {
								// 根目录不提供“一键全选保护”（等于关掉整个清理能力）；只做相反的“取消全部”
								labels2.push(`🧹 取消全部保护（清空安全名单，当前 ${entries.length} 条）`);
							} else {
								labels2.push(
									hasOwn
										? `☑️ 取消保护：${shownDir(browse)}`
										: isCovered(browse)
											? `🔒 已受上级/通配条目保护：${shownDir(browse)}（如需单独特例请编辑名单文件）`
											: `⬜ 加入安全名单：${shownDir(browse)}（其下全部文件）`,
								);
							}
							if (browse) labels2.unshift("⬆️ 返回上一级"); // 置顶：返回好找；末项固定是切换按钮
							const picked2 = await ctx.ui.select(
								`🔒 安全名单（${listFile}）\n当前位置：${shownDir(browse)}${isCovered(browse) ? "（🔒 已保护）" : ""}\n` +
								`点文件夹继续往下钻；末项按钮 = 切换当前目录保护（根目录 = 清空名单）；Esc 退出`,
								labels2,
							);
							if (picked2 === undefined) break;
							if (picked2.startsWith("⬆️")) {
								browse = browse.includes("/") ? browse.slice(0, browse.lastIndexOf("/")) : "";
								continue;
							}
							if (picked2.startsWith("📁")) {
								const n = picked2.slice(2).split("   ")[0].trim();
								if (n) browse = browse ? `${browse}/${n}` : n;
								continue;
							}
							if (picked2.startsWith("🧹")) {
								if (entries.length === 0) {
									ctx.ui.notify("安全名单本来就是空的，无需清空", "info");
									continue;
								}
								const ok = await ctx.ui.confirm(
									"取消全部保护",
									`将清空安全名单里的 ${entries.length} 条条目（说明性注释保留）。清空后所有文件都可清理，删除仍会先移入 ${CONFIG.trashName} 暂存区（/trash restore 可找回）。`,
								);
								if (!ok) continue;
								try {
									// 只删条目，保留 # 注释（名单头部说明）
									const kept = readAllLines().filter((l) => {
										const t = l.trim();
										return !t || t.startsWith("#");
									});
									fs.writeFileSync(listFile, `${kept.join("\n").replace(/\n+$/, "")}\n`, "utf8");
									protectCache = null;
									ctx.ui.notify(`🧹 已清空安全名单：移除 ${entries.length} 条，当前不保护任何文件`, "info");
								} catch (err) {
									ctx.ui.notify(`写入安全名单失败：${err instanceof Error ? err.message : String(err)}`, "error");
								}
								continue;
							}
							try {
								if (hasOwn) {
									// 取消保护 = 移除该目录的条目（含手写的 `目录/`、`目录/**`）
									fs.writeFileSync(listFile, entries.filter((e) => e.startsWith("!") || stripDir(e) !== browse).join("\n") + "\n", "utf8");
									protectCache = null;
									ctx.ui.notify(`📂 已取消保护：${browse}（其内文件可被清理，.trash 里仍可找回）`, "info");
								} else if (isCovered(browse)) {
									ctx.ui.notify(`🔒 ${shownDir(browse)} 由上级/通配条目保护，如需调整请编辑 ${listFile}`, "info");
								} else {
									fs.appendFileSync(listFile, `${browse ? `${browse}/**` : "**"}\n`, "utf8");
									protectCache = null;
									ctx.ui.notify(`📂 已加入安全名单：${browse ? `${browse}/**` : "**（全部文件）"}（其内文件永不被清理）`, "info");
								}
							} catch (err) {
								ctx.ui.notify(`写入安全名单失败：${err instanceof Error ? err.message : String(err)}`, "error");
							}
						}
						remaining = audit();
						continue;
					}
					if (picked.startsWith("📌")) {
						// 全部移入只需确认一次（暂存区可找回，风险低）；受保护项自动排除
						const all = movable;
						if (all.length === 0) {
							ctx.ui.notify("🔒 剩余项全部受保护，未移动", "info");
							break;
						}
						const skipped = remaining.length - all.length;
						const ok = await ctx.ui.confirm(
							"全部移入暂存区",
							`将 ${all.length} 个文件移入 .trash 暂存区（可用 /trash restore 找回）？${skipped > 0 ? `\n\n（🔒 ${skipped} 个受保护文件将被跳过）` : ""}`,
						);
						if (!ok) return;
						for (const f of all) await moveOne(f.file, false);
						remaining = remaining.filter((f) => guardOf(f.file));
						if (skipped > 0) ctx.ui.notify(`🔒 ${skipped} 个受保护文件已跳过（如需处理请单独选择）`, "info");
						if (remaining.length === 0) break;
						continue;
					}
					if (picked.startsWith("✅")) break;
					const target = remaining.find((f) => labelOf(f) === picked);
					if (!target) continue;
					const g = guardOf(target.file);
					if (g) {
						const ok = await ctx.ui.confirm(`🔒 ${path.basename(target.file)} 受保护`, `${g}。仍要移入暂存区？（可用 /trash restore 找回）`);
						if (!ok) continue;
					}
					await moveOne(target.file, !!g);
					remaining = remaining.filter((f) => f !== target);
				}
				if (remaining.length === 0 && flags.length > 1) {
					ctx.ui.notify(`全部处理完毕 ✅${guardedFlags.length > 0 ? `（其中 ${guardedFlags.length} 个受保护项未动）` : ""}`, "info");
				}
			} catch {
				/* 用户取消或 UI 异常 */
			}
		},
	});

	// （安全名单的入口只有 /files 菜单里的「📂 安全名单」一项：选目录即加入/取消保护，无斜杠命令）

	// ---------- /trash 命令 ----------
	pi.registerCommand("trash", {
		description: "管理删除暂存区 .trash：列出 / 恢复 / 清空",
		handler: async (_args, ctx) => {
			logDbg("command trash invoked");
			const items = listTrash();
			if (items.length === 0) {
				ctx.ui?.notify?.("🗑️ 删除暂存区为空", "info");
				return;
			}
			if (typeof ctx.ui?.select !== "function") {
				ctx.ui?.notify?.(
					`🗑️ 暂存区 ${items.length} 项：\n` +
						items.slice(0, 20).map((i) => i.rel).join("\n") +
						(items.length > 20 ? `\n…共 ${items.length} 项` : "") +
						`\n在 TUI 中输入 /trash 可交互恢复`,
					"info",
				);
				return;
			}
			try {
				const action = await ctx.ui.select(
					`🗑️ 删除暂存区 ${items.length} 项`,
					["恢复文件", "清空暂存区", "取消"],
				);
				if (action === undefined || action === "取消") return;
				if (action === "清空暂存区") {
					const ok = await ctx.ui.confirm("确认清空", `永久删除暂存区全部 ${items.length} 项？将无法找回。`);
					if (!ok) return;
					const n = emptyTrash();
					updateWidget(ctx);
					ctx.ui.notify(`已清空 ${n} 项`, "info");
					return;
				}
				// 恢复
				const labels = items.map((i) =>
					`${i.rel}（${i.size > 0 ? (i.size / 1024).toFixed(1) + "KB" : "空"}，${new Date(i.mtime).toLocaleString() ?? ""}）`,
				);
				const picked = await ctx.ui.select("选择要恢复的文件", labels);
				if (picked === undefined) return;
				const idx = labels.indexOf(picked);
				const item = items[idx];
				let overwrite = false;
				if (fs.existsSync(path.join(cwd, item.rel))) {
					overwrite = await ctx.ui.confirm(`目标已存在：${item.rel}`, "覆盖原文件？选择“否”则跳过。");
				}
				const r = restoreFromTrash(item.rel, overwrite);
				if (r.ok) {
					updateWidget(ctx);
					ctx.ui.notify(`✅ 已恢复到 ${r.dest}`, "info");
				} else {
					ctx.ui.notify(`恢复失败（${r.reason}）`, "error");
				}
			} catch {
				/* 用户取消 */
			}
		},
	});
}
