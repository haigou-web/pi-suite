// skill-gate.ts — pi 扩展：技能路由闸门（生产用）
//
// 逻辑（真实 48 例实测：covered 94% / wrong 0% / needless 9%，官方基线 75/6/28）：
//   stage-1 全候选 choice（+3 个 noul 探针）→ top-3；stage-2 top-3 + none 再 choice → winner / pNone
//   decision: load ⟺ winner 属于 top-3 且 pNone < 0.40
// 逻辑本体在 ./skill-gate/gate.mjs（与回放器 replay-gate.mjs 共用，仅此一份）。
//
// pi 扩展 API 依据（pi 官方 docs/extensions.md）：
//   ① input 是唯一能在「提交后、技能展开前」同步改写本次请求的 hook；改写为 /skill:<name> <原文> 走正规技能展开
//   ② 技能清单用 before_agent_start 的 event.systemPromptOptions.skills
//   ③ 框架无 hook 超时 → 自加 AbortSignal.timeout（在 gate.mjs 内）
//   ④ 模块加载期 / factory 体内抛错会让整个 pi exit 1 → 顶层与 factory 体内只声明，不做任何可能抛错的事
//
// 通道（2026-10-03 起双通道，逻辑在 gate.mjs）：
//   ① registry —— 把 ctx.modelRegistry 交给 gate.mjs，优先走 pi **官方分类器通道**（与 pi 内置 Jev 同源）
//   ② http     —— 老的「自读 key + fetch 直连」；registry 不可用 / 报错时自动回退
//
// 开关（env）：
//   PI_SKILL_GATE=off              → 完全停用（input 直接放行，不再注入建议）
//   PI_SKILL_GATE_MODE=advise      → 不改写消息，只在 before_agent_start 注入 [路由建议] 上下文块
//   PI_SKILL_GATE_MODE=load(缺省)  → 命中即改写为 /skill:<name> <原文>
//   PI_SKILL_GATE_VIA=http         → 强制走老 HTTP 通道（回滚开关；缺省 auto = 官方优先 + HTTP 兜底）
//   PI_SKILL_GATE_KEY_FILE=<path>  → 指定 .typesafe_key.txt 位置（仅影响 HTTP 通道与 env 桥接）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi 的 agent 目录：默认 ~/.pi/agent，可用 PI_AGENT_DIR 覆盖
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");

const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 同 prompt 结果缓存 30 分钟
const CACHE_MAX = 200;
const LOG_PATH = process.env.PI_SKILL_GATE_LOG || path.join(LOG_DIR, "skill-gate.jsonl");
const PROMPT_KEY_LEN = 400; // 去空白 + 小写 + 截断 400 字
const DEFAULT_KEY_FILE = process.env.PI_SKILL_GATE_KEY_FILE || path.join(AGENT_DIR, ".typesafe_key.txt");

// 官方通道：把 key 桥进 TYPESAFE_API_KEY（pi 的 typesafe provider 只认它），再把 ctx.modelRegistry 交给 gate.mjs。
// 拿不到 registry（老版 pi / 非扩展环境）或官方通道报错时，gate.mjs 内部会自动回退到 HTTP —— 不会比改前更差。
let envKeyBridged = false;
function ensureTypesafeEnvKey(keyFile: string): void {
  try {
    if (envKeyBridged) return;
    envKeyBridged = true;
    if (env("TYPESAFE_API_KEY").trim()) return; // 已经设了就不动（/login 存的凭据优先级更高，pi 自己会取）
    const k = fs.readFileSync(keyFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (k) process.env.TYPESAFE_API_KEY = k;
  } catch {
    /* 读不到就算了：官方通道会失败并自动回退到 HTTP */
  }
}

type Sk = {
  name: string;
  description: string;
  // 由 gate.mjs::deriveFromSkillFile 从 SKILL.md 推导（与实验 roster.json 口径一致）
  description_full?: string;
  body?: string;
  filePath?: string;
  disableModelInvocation?: boolean;
};

type RouteResult = {
  skill: string | null;
  winner: string | null;
  pNone: number | null;
  top3: string[];
  via?: string | null; // "registry" | "http" | "mixed" | null（老结果没这个字段）
  calls: number;
  ms: number;
  inTok: number;
  outTok: number;
  error?: string;
};

type RouteFn = (opts: {
  prompt: string;
  skills: Sk[];
  timeoutMs?: number;
  logPath?: string;
  registry?: any; // pi 的 ctx.modelRegistry；传了则优先走官方通道
}) => Promise<RouteResult>;

// 动态 import：放在 handler 内首次调用时才加载，加载失败也只是降级为 continue，
// 绝不让 gate.mjs 的任何问题变成 pi 启动失败。
let modPromise: Promise<any | null> | null = null;
function loadModule(): Promise<any | null> {
  try {
    if (!modPromise) modPromise = import("./skill-gate/gate.mjs").catch(() => null);
    return modPromise;
  } catch {
    return Promise.resolve(null);
  }
}
function loadRoute(): Promise<RouteFn | null> {
  return loadModule().then((m: any) => (typeof m?.route === "function" ? (m.route as RouteFn) : null));
}

function env(name: string): string {
  try {
    return String(process.env[name] ?? "");
  } catch {
    return "";
  }
}

function cacheKey(prompt: string, skills: Sk[]): string {
  let names = "";
  try {
    names = skills.map((s) => s.name).join(",");
  } catch {
    names = "";
  }
  return names + "|" + prompt.replace(/\s+/g, " ").trim().toLowerCase().slice(0, PROMPT_KEY_LEN);
}

export default function (pi: ExtensionAPI) {
  let skills: Sk[] = [];
  const cache = new Map<string, { at: number; res: RouteResult }>();

  async function routeFor(prompt: string, list: Sk[], registry: any): Promise<RouteResult | null> {
    const key = cacheKey(prompt, list);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.res;
    const routeFn = await loadRoute();
    if (!routeFn) return null;
    const res = await routeFn({
      prompt,
      skills: list,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      logPath: LOG_PATH,
      ...(registry ? { registry } : {}),
    });
    // 只缓存成功结果：一次网络抖动不该被钉住 30 分钟
    if (res && !res.error) {
      cache.set(key, { at: Date.now(), res });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return res;
  }

  // 通道选择：PI_SKILL_GATE_VIA=http 时强制老路子；否则把 ctx.modelRegistry 交给 gate.mjs（官方通道优先）。
  function registryFor(ctx: any): any {
    try {
      if (env("PI_SKILL_GATE_VIA").trim().toLowerCase() === "http") return null;
      ensureTypesafeEnvKey(env("PI_SKILL_GATE_KEY_FILE").trim() || DEFAULT_KEY_FILE);
      return (ctx as any)?.modelRegistry ?? null;
    } catch {
      return null;
    }
  }

  // ---- 采集技能清单（只采集，不改提示）；advise 模式下在此注入建议 ----
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const list = event?.systemPromptOptions?.skills;
      if (Array.isArray(list)) {
        // 保真：pi 的 Skill 只带 description；实验口径用的是 build-roster.ps1 从 SKILL.md
        // 推导的 description_full + body[:1600]。两者不同会让 stage-1/2 的候选文本漂移，
        // 故此处按同一推导补齐（推导实现只有一份，在 gate.mjs，可被回放器/验证器直接调用）。
        const mod = await loadModule();
        const derive =
          mod && typeof mod.deriveFromSkillFile === "function" ? mod.deriveFromSkillFile : null;
        skills = list
          .filter((s: any) => s && typeof s.name === "string" && s.name)
          .map((s: any) => {
            const filePath = typeof s.filePath === "string" ? s.filePath : undefined;
            const d = derive && filePath ? derive(filePath) : null;
            const piDesc = typeof s.description === "string" ? s.description : "";
            return {
              name: s.name,
              description: (d && d.description_full) || piDesc,
              ...(d ? { description_full: d.description_full || undefined, body: d.body } : {}),
              filePath,
              disableModelInvocation: s.disableModelInvocation === true,
            };
          });
      }
      if (env("PI_SKILL_GATE") === "off") return undefined;
      if (env("PI_SKILL_GATE_MODE") !== "advise") return undefined;
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      if (!prompt.trim() || skills.length === 0) return undefined;

      const res = await routeFor(prompt, skills, registryFor(ctx));
      if (!res || !res.skill) return undefined;
      const hit = skills.find((s) => s.name === res.skill);
      if (!hit || hit.disableModelInvocation === true) return undefined;
      const pn = res.pNone === null ? "n/a" : res.pNone.toFixed(2);
      const cand = res.top3.join(" / ");
      return {
        message: {
          customType: "skill-gate",
          content:
            "[路由建议] 建议加载技能 " +
            res.skill +
            "（pNone=" +
            pn +
            "，top3=" +
            cand +
            "）。" +
            "若确与本请求无关可忽略本条；如需加载请用 /skill:" +
            res.skill +
            " 显式调用。",
          display: true,
        },
      };
    } catch {
      return undefined;
    }
  });

  // ---- 闸门本体：命中即在技能展开前改写为 /skill:<name> <原文> ----
  pi.on("input", async (event: any, ctx: any) => {
    try {
      if (env("PI_SKILL_GATE") === "off") return { action: "continue" };
      if (env("PI_SKILL_GATE_MODE") === "advise") return { action: "continue" };
      if (!event || event.source === "extension") return { action: "continue" };
      const text = typeof event.text === "string" ? event.text : "";
      if (!text.trim() || text.trimStart().startsWith("/")) return { action: "continue" };
      if (skills.length === 0) return { action: "continue" };

      const res = await routeFor(text, skills, registryFor(ctx));
      if (!res || !res.skill) return { action: "continue" };
      const hit = skills.find((s) => s.name === res.skill);
      if (!hit || hit.disableModelInvocation === true) return { action: "continue" };
      return { action: "transform", text: "/skill:" + res.skill + " " + text };
    } catch {
      return { action: "continue" };
    }
  });
}
