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
 *   2 multistep-gate     before_agent_start 注入步进锚点
 *   3 rules-hooks        H9 / H11 拦截 + 全量记录（H7 已于 09-23 删）
 *   4 session-file-audit 会话文件审计、/files、/trash
 *   5 skill-gate         input 技能路由改写
 *   6 image-offload      tool_result 拦截：read 的图片转写为文本、不进主会话（2026-09-28 并入）
 *
 * 2026-10-07 移除 @tintinweb/pi-tasks 及其三个配套模块（用户决定）：
 *   · pi-tasks-bridge    子 Agent RPC 桥 —— 只为 pi-tasks 的 TaskExecute 服务，无它则无事可做
 *   · tool-prune         摘 TaskGet/TaskOutput/TaskStop/TaskExecute —— 无对象可摘
 *   · multistep-gate/tasks-reconcile.mjs  任务面板对账 —— 无任务存储文件可读
 *   另：pi-tasks 的 promptGuidelines 曾在 2026-10-04 被本地清空（dist/index.js），该改动随包一并移除。
 *
 * 容错：每个模块的工厂分别用 try/catch 包住 —— 一个模块注册失败只降级它自己，
 * 不影响其余模块，也不会让整个 pi 起不来（与合并前「各自独立加载」的隔离性等价）。
 * 失败会写一条 pi-suite 会话条目 + stderr，便于事后发现，绝不静默。
 *
 * 实现依据：pi 的扩展发现规则（dist/core/extensions/loader.js：目录下 `<name>.ts`、`<name>.js`，
 * 以及子目录的 `index.ts` / `index.js`）——
 * 因此 ./modules/ 里的模块不会再被单独加载，正好避免重复注册。
 *
 * 注册幂等（2026-10-05 追加；2026-10-06 修正）：
 *   pi 每次加载扩展都会新建 extension 对象（loader.js:508 createExtension，含全新 handlers Map），
 *   handler 天然不会跨加载累积。2026-10-05 观察到的「同一毫秒 4 条相同 think_guard 日志」
 *   实为 4 个会话/进程同时触发所致，并非 handler 累积。
 *   当时的对策（模块级 activeDisposers）反而有害：pi-web 在同一个 Node 进程里托管多个会话，
 *   新会话加载时会注销「上一个会话的 handler」，把别的会话的钩子全部删掉 —— 表现为同一时刻
 *   只有最后一个加载的会话判定有效，其余会话的 before_agent_start 静默（判定不执行、不写日志）。
 *   现改为按 pi 实例隔离（WeakMap，见 disposersByInstance）：同一实例重入才注销，跨会话互不影响。
 * 这是本文件唯一一处「非零逻辑改写」——各模块内部逻辑仍与合并前逐字一致。
 *
 * 回滚：删掉本目录、把 ./modules/ 下的条目搬回 ~/.pi/agent/extensions/ 即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hardRules from "./modules/hard-rules.ts";
import multistepGate from "./modules/multistep-gate.ts";
import rulesHooks from "./modules/rules-hooks.ts";
import sessionFileAudit from "./modules/session-file-audit/index.ts";
import skillGate from "./modules/skill-gate.ts";
import imageOffload from "./modules/image-offload.ts";

const MODULES: Array<[string, (pi: any) => any]> = [
  ["hard-rules", hardRules],
  ["multistep-gate", multistepGate],
  ["rules-hooks", rulesHooks],
  ["session-file-audit", sessionFileAudit],
  ["skill-gate", skillGate],
  ["image-offload", imageOffload],
];

/**
 * 上一批注册产生的注销函数 —— **按 pi 实例隔离**（一个 pi 实例 = 一次扩展加载 = 一个会话）。
 *
 * 2026-10-06 修复跨会话误杀：
 *   旧实现是模块级数组，在进程内所有会话间共享。pi-web 是「单 Node 进程 + 多会话」，
 *   每个会话各加载一次扩展，于是「新会话加载」会去注销「上一个会话的 handler」，
 *   把别的会话的钩子删光 —— 实测同进程内两个会话相隔 1 分钟，一个判定正常、一个全无记录。
 *
 *   改 WeakMap 后：同一 pi 实例重入 → 命中 → 注销旧批（保留原「防重复」意图）；
 *   新会话（新 pi 对象）→ 不命中 → 不动任何其他会话。
 *   （另注：loader.js:508 每次加载都新建 extension 对象，handler 本就不会累积，
 *     因此本机制在跨会话场景下只剩「不误杀」这一个要求。）
 */
const disposersByInstance = new WeakMap<object, Array<() => void>>();

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
  // ① 先注销「同一个 pi 实例」的上一批句柄；新会话（新 pi 对象）不受影响。
  //    旧句柄可能已随旧 ctx 失效，注销失败可忽略。
  const stale = disposersByInstance.get(pi) ?? [];
  const fresh: Array<() => void> = [];
  disposersByInstance.set(pi, fresh);
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
