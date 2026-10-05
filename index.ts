/**
 * pi-suite/index.ts —— 7 个扩展的单一入口（2026-09-22 合并；2026-09-28 并入 image-offload）
 *
 * 为什么合并：这些扩展在同一个生命周期时机上互相重叠 ——
 *   session_start 5 个、tool_call 3 个、message_end 3 个、
 *   before_agent_start / context 各 2 个、tool_result 3 个。
 * 分开加载时「谁先跑」取决于 pi 的目录发现顺序（不可控）；合并后由本文件显式固定顺序。
 *
 * 合并方式：**零逻辑改写**。各模块原样搬到 ./modules/ 下，各自仍导出默认工厂函数，
 * 本文件只负责按固定顺序点名调用。模块内部一律用相对路径找自己的资源
 * （./hard-rules/rules.mjs、./multistep-gate/judge.mjs、./skill-gate/gate.mjs），搬迁不断链。
 *
 * 顺序（= 合并前面板里显示的顺序，逐钩子注册次序与合并前一致）：
 *   1 hard-rules         tool_call 拦截：read 直读 pdf/docx/pptx/xlsx、monica 生图缺 -Model
 *   2 multistep-gate     before_agent_start 注入步进锚点 + turn_start/tool_result/context 任务面板对账
 *   3 tool-prune      session_start/before_agent_start：摘掉用不上的 TaskGet/TaskOutput/TaskStop/TaskExecute（2026-10-04）
 *   4 rules-hooks        H9 / H11 拦截 + 全量记录（H7 已于 09-23 删）
 *   5 session-file-audit 会话文件审计、/files、/trash
 *   6 skill-gate         input 技能路由改写
 *   7 image-offload      tool_result 拦截：read 的图片转写为文本、不进主会话（2026-09-28 并入）
 *
 * 容错：每个模块的工厂分别用 try/catch 包住 —— 一个模块注册失败只降级它自己，
 * 不影响其余模块，也不会让整个 pi 起不来（与合并前「各自独立加载」的隔离性等价）。
 * 失败会写一条 pi-suite 会话条目 + stderr，便于事后发现，绝不静默。
 *
 * 实现依据：pi 的扩展发现规则（dist/core/extensions/loader.js：目录下 `<name>.ts`、`<name>.js`，
 * 以及子目录的 `index.ts` / `index.js`）——
 * 因此 ./modules/ 里的模块不会再被单独加载，正好避免重复注册。
 *
 * 注册幂等（2026-10-05 追加）：pi 在 /reload 或会话替换时会重新执行本模块并再次调用工厂，
 * 而 pi.on() 注册的 handler 若不被注销，会在同一扩展实例的 handlers 列表里累积 ——
 * 表现为同一个事件被处理 N 次。实测（hard-rules.jsonl 2026-10-05 02:46）：同一毫秒出现
 * 4 条 think_guard 日志且 chars 值完全相同（4 个独立闭包各自累加到同一数值），
 * 对应 4 次 ctx.abort() 与 4 条重复提示。
 * 对策：工厂每次重入时先注销上一批句柄（见 activeDisposers），保证任何时刻只有一份 handler 生效。
 * 这是本文件唯一一处「非零逻辑改写」——各模块内部逻辑仍与合并前逐字一致。
 *
 * 回滚：删掉本目录、把 ./modules/ 下的条目搬回 ~/.pi/agent/extensions/ 即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hardRules from "./modules/hard-rules.ts";
import multistepGate from "./modules/multistep-gate.ts";
import toolPrune from "./modules/tool-prune.ts";
import rulesHooks from "./modules/rules-hooks.ts";
import sessionFileAudit from "./modules/session-file-audit/index.ts";
import skillGate from "./modules/skill-gate.ts";
import imageOffload from "./modules/image-offload.ts";

const MODULES: Array<[string, (pi: any) => any]> = [
  ["hard-rules", hardRules],
  ["multistep-gate", multistepGate],
  ["tool-prune", toolPrune],
  ["rules-hooks", rulesHooks],
  ["session-file-audit", sessionFileAudit],
  ["skill-gate", skillGate],
  ["image-offload", imageOffload],
];

/**
 * 上一批注册产生的注销函数（模块级，跨工厂调用保留）。
 *
 * pi 的扩展加载器（dist/core/extensions/loader.js）在 /reload 时会重新执行本模块，
 * 于是工厂被再次调用、handler 被再次注册。若不主动注销，同一个事件会触发多份 handler。
 * 每次重入先清空上一批，保证「任何时刻只有一份」。
 */
let activeDisposers: Array<() => void> = [];

/**
 * 包住 pi.on()，把返回的注销函数收集进 sink。
 * 覆盖失败（pi 对象不可写）时静默降级为「不追踪」，行为与改造前一致，不影响模块本身。
 */
function trackOn(pi: any, sink: Array<() => void>): boolean {
  if (typeof pi.on !== "function") return false;
  const raw = pi.on.bind(pi);
  try {
    const wrapped = (event: any, handler: any) => {
      const dispose = raw(event, handler);
      if (typeof dispose === "function") sink.push(dispose);
      return dispose;
    };
    pi.on = wrapped;
    return pi.on === wrapped; // 写入未生效（如 pi 被冻结）则返回 false
  } catch {
    return false;
  }
}

/**
 * 在 run() 执行期间把 pi.events 临时换成一个只改写 on() 的代理，用来记录注销函数；
 * run() 结束后立即还原成真正的 EventBus。
 *
 * 为什么不直接覆盖 pi.events.on：EventBus 是全局共享的，直接覆盖会把别的扩展注册的
 * handler 也记进 sink，重入注销时就会误伤它们。临时替换只影响本工厂的执行窗口。
 * 代理上的其余方法一律 bind 到真总线，避免 EventBus 内部的私有字段因 this 错位而失效。
 */
function withTrackedEventBus(pi: any, sink: Array<() => void>, run: () => void): boolean {
  const real = pi?.events;
  if (!real || typeof real.on !== "function") {
    run();
    return false;
  }
  const proxy: any = {};
  for (const key of Object.getOwnPropertyNames(real)) {
    if (key === "on") continue;
    const value = real[key];
    proxy[key] = typeof value === "function" ? value.bind(real) : value;
  }
  proxy.on = (event: any, handler: any) => {
    const dispose = real.on(event, handler);
    if (typeof dispose === "function") sink.push(dispose);
    return dispose;
  };

  let swapped = false;
  try {
    pi.events = proxy;
    swapped = pi.events === proxy;
  } catch {
    /* pi 对象不可写：降级为不追踪 */
  }
  try {
    run();
  } finally {
    if (swapped) {
      try {
        pi.events = real;
      } catch {
        /* ignore */
      }
    }
  }
  return swapped;
}

/**
 * 注意：pi.registerCommand(name, options) 的返回类型是 void —— pi 没有提供命令注销接口，
 * 因此同名命令的重复注册只能依赖 pi 自身按名覆盖，本文件无法代为清理。
 */
export default function piSuite(pi: ExtensionAPI) {
  // ① 先注销上一批句柄。旧句柄可能已随旧 ctx 失效，注销失败可忽略。
  const stale = activeDisposers;
  const fresh: Array<() => void> = [];
  activeDisposers = fresh;
  for (const dispose of stale) {
    try {
      dispose();
    } catch {
      /* 旧句柄已随旧 ctx 失效 */
    }
  }

  // ② 追踪本批注册（pi.on + 工厂窗口内的 pi.events.on）
  const onTracked = trackOn(pi, fresh);
  const busTracked = withTrackedEventBus(pi, fresh, () => {
    // ③ 按固定顺序注册各模块
    for (const [name, register] of MODULES) {
      try {
        register(pi);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        // 响亮但不致命：写会话条目 + stderr，其余模块照常注册
        try {
          pi.appendEntry("pi-suite-load-error", { module: name, error: msg, t: new Date().toISOString() });
        } catch {
          /* ignore */
        }
        try {
          console.error(`[pi-suite] 模块 ${name} 注册失败（已跳过，其余模块不受影响）：${msg}`);
        } catch {
          /* ignore */
        }
      }
    }
  });

  // ④ 静默成功、响亮失败：追踪没完全启用时写一条记录，便于事后发现「reload 后又开始累积」
  if (!onTracked || !busTracked) {
    try {
      pi.appendEntry("pi-suite-dispose-tracking", {
        on: onTracked,
        events: busTracked,
        note: "注销追踪未完全启用（pi 对象可能不可写）：/reload 后 handler 可能重新累积",
        t: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }
  }
}
