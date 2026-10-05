/**
 * image-offload（pi-suite 模块 · 第 7 位）—— 让图片不进主会话。
 *
 * 动机：
 *   图片 content part 会打断 prompt 前缀复用，下一次请求整个 prompt 全额重算
 *   （实测单次 miss 40K+，9/27 单日 IMAGE 类未命中 404K / 占 35.4%）；
 *   且图片一旦进入主会话历史，ACP 压缩会整条跳过含图消息（mediaExcluded），
 *   压不掉、越滚越贵。
 *
 * 机制：
 *   tool_result 阶段拦截 read 返回的 image part → 用一次独立模型调用
 *   （不进主会话、cacheRetention=none）转写成详尽文本描述 →
 *   把「原有非图片内容 + 描述」交回主会话。图片字节永不落进 transcript。
 *
 * 安全：
 *   一律 fail-open。模型不可用 / 调用抛错 / stopReason=error / 超时 / 返回空
 *   —— 任何异常都原样放行图片，绝不因为省缓存把读图功能弄坏。
 *
 * 开关：
 *   /imgraw                         会话内临时放行原图（再执行一次恢复）
 *   PI_IMAGE_OFFLOAD=0              全局关闭本模块
 *   PI_IMAGE_OFFLOAD_MAX_TOKENS     描述长度上限（默认 1600）
 *   PI_IMAGE_OFFLOAD_TIMEOUT_MS     单张图转写超时（默认 90000）
 *
 * 与同套件其它模块的关系：
 *   session-file-audit 的 tool_result 钩子会向 event.content 追加提示；
 *   本模块因此【保留原有非图片内容】再追加描述，避免覆盖它的追加
 *   （tool_result 各 handler compose，谁先谁后都不丢内容）。
 *   在 MODULES 中排最后，让其它钩子先按原样看到 read 的结果。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ImagePart = { type: "image"; data: string; mimeType: string };
type TextPart = { type: "text"; text: string };
type Part = TextPart | ImagePart;

const DISABLED = process.env.PI_IMAGE_OFFLOAD === "0";
const MAX_TOKENS = Number(process.env.PI_IMAGE_OFFLOAD_MAX_TOKENS || 1600);
const TIMEOUT_MS = Number(process.env.PI_IMAGE_OFFLOAD_TIMEOUT_MS || 90000);

/** 会话内临时放行原图（/imgraw 切换），仅存于扩展进程，不写盘 */
let rawPass = false;

const PROMPT = [
	"你是图像转写器。读你文字的人看不到这张图，你的文本必须能替代原图。",
	"按下列顺序输出，有则写、无则跳过：",
	"① 这是什么：截图 / 照片 / 图表 / 界面 / 文档页，整体构图与分区；",
	"② 文字：逐字抄录图中所有可见文字，保持原语言、大小写与换行；数字、代码、URL、按钮标签一个不漏；",
	"③ 图形元素：框、线、箭头、图标、表格行列结构、曲线走势；",
	"④ 颜色：重要元素标注其颜色与所在位置；",
	"⑤ 空间关系：用方位词说明元素相对位置（如「左上角」「下方居右」）；",
	"⑥ 一切可见数值：坐标、尺寸、百分比、序号、时间。",
	"只描述确实看到的内容，不要推测、不要补充背景。看不清的部分明确写「此处无法辨认」。",
	"直接输出描述正文，不要客套语、不要总结、不要提问。",
].join("\n");

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
		return sm?.getSessionId?.() ?? undefined;
	} catch {
		return undefined;
	}
}

/** opencode 系 provider 必须带 x-opencode-session 才能路由（裸 complete 不注入该头） */
function opencodeHeadersFor(model: unknown, sid?: string): Record<string, string> | undefined {
	if (!sid) return undefined;
	const m = model as { provider?: string; baseUrl?: string } | undefined;
	const isOc =
		m?.provider === "opencode" || m?.provider === "opencode-go" || /opencode\.ai/i.test(m?.baseUrl ?? "");
	return isOc ? { "x-opencode-session": sid, "x-opencode-client": "pi" } : undefined;
}

/** 通用 usage 累加：不需要预先知道字段名，数值相加、对象递归 */
function mergeUsage(acc: Record<string, unknown>, add: unknown): Record<string, unknown> {
	if (!add || typeof add !== "object") return acc;
	for (const [k, v] of Object.entries(add as Record<string, unknown>)) {
		if (typeof v === "number") {
			acc[k] = (typeof acc[k] === "number" ? (acc[k] as number) : 0) + v;
		} else if (v && typeof v === "object") {
			acc[k] = mergeUsage((acc[k] as Record<string, unknown>) ?? {}, v);
		} else if (acc[k] === undefined) {
			acc[k] = v;
		}
	}
	return acc;
}

export interface OffloadResult {
	text: string;
	usage: Record<string, unknown>;
}

/**
 * 把一组图片转写成文本。任何失败返回 null（调用方据此 fail-open 保留原图）。
 * 导出以便离线自测（见 selftest-image-offload.mjs）。
 */
export async function describeImages(
	ctx: ExtensionContext,
	images: ImagePart[],
	opts?: { model?: unknown; registry?: unknown; signal?: AbortSignal; label?: string },
): Promise<OffloadResult | null> {
	const registry = (opts?.registry ??
		(ctx as unknown as { modelRegistry?: unknown }).modelRegistry) as
		| { complete?: (m: unknown, req: unknown, o: unknown) => Promise<unknown> }
		| undefined;
	const model = opts?.model ?? (ctx as unknown as { model?: unknown }).model;
	if (!registry?.complete || !model) return null;

	const ac = new AbortController();
	const parent = opts?.signal ?? (ctx as unknown as { signal?: AbortSignal }).signal;
	if (parent) {
		if (parent.aborted) return null;
		parent.addEventListener("abort", () => ac.abort(), { once: true });
	}
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

	const headers = opencodeHeadersFor(model, sessionIdOf(ctx));
	const usage: Record<string, unknown> = {};
	const blocks: string[] = [];
	try {
		for (let i = 0; i < images.length; i++) {
			const img = images[i];
			const res = (await registry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: PROMPT },
								{ type: "image", data: img.data, mimeType: img.mimeType },
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: MAX_TOKENS,
					signal: ac.signal,
					cacheRetention: "none",
					...(headers ? { headers } : {}),
				},
			)) as
				| {
						stopReason?: string;
						errorMessage?: string;
						content?: { type?: string; text?: string }[];
						usage?: unknown;
				  }
				| undefined;

			// 模型侧错误不抛异常，而是 stopReason=error + errorMessage 返回
			if (!res || res.stopReason === "error" || res.errorMessage) return null;
			const text = (res.content ?? [])
				.filter((c) => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n")
				.trim();
			if (!text) return null;
			blocks.push(images.length > 1 ? `【第 ${i + 1} 张】\n${text}` : text);
			mergeUsage(usage, res.usage);
		}
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	if (blocks.length === 0) return null;
	const head = `[image-offload] 图片未进入上下文，以下为独立模型转写的文本描述（原图：${opts?.label ?? "见上"}）。`;
	return { text: `${head}\n\n${blocks.join("\n\n")}`, usage };
}

export default function imageOffload(pi: ExtensionAPI) {
	if (DISABLED) return;

	pi.registerCommand("imgraw", {
		description: "临时放行/拦截 read 到的原图（image-offload 开关）",
		handler: async (_args: string, ctx: ExtensionContext) => {
			rawPass = !rawPass;
			try {
				ctx.ui?.notify?.(
					rawPass
						? "🖼 已放行原图：read 的图片将直接进入上下文（缓存不友好）"
						: "📄 已恢复拦截：图片转写为文本，不进入上下文",
					"info",
				);
			} catch {
				/* ignore */
			}
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (rawPass) return;
			if (event.toolName !== "read" || event.isError) return;
			const parts = (event.content ?? []) as Part[];
			const images = parts.filter(
				(c): c is ImagePart => (c as ImagePart)?.type === "image" && typeof (c as ImagePart).data === "string",
			);
			if (images.length === 0) return;

			const label = String((event.input as { path?: unknown } | undefined)?.path ?? "");
			const out = await describeImages(ctx, images, label ? { label } : undefined);
			if (!out) return; // fail-open：保持原图

			// 保留原有非图片内容（其它模块可能已向 content 追加过东西），再追加描述
			const kept = parts.filter((c): c is TextPart => (c as TextPart)?.type === "text");
			return { content: [...kept, { type: "text", text: out.text }], usage: out.usage };
		} catch {
			return; // fail-open
		}
	});
}
