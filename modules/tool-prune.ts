/**
 * tool-prune —— 把用不上的工具从「已启用」集合里摘掉（2026-10-04 新增）
 *
 * 背景：pi-web 的「工具使用次数」面板显示 7 个 Task* 工具近 7 天调用为 0。
 * 其中 TaskGet（查单条任务）、TaskOutput（取后台输出）、TaskStop（停任务）、
 * TaskExecute（派子代理跑任务，与 acp_delegate 功能重叠）从未被使用；
 * TaskCreate / TaskList / TaskUpdate 保留（仍在用/可能用）。
 *
 * 为什么不用其它办法：
 *   · settings.json 的 defaultTools 只能「启用」注册时未激活的扩展工具，不能禁用已激活的（docs/settings.md:56）。
 *   · pi-tasks 自己的配置（tasks-config.ts）只有面板显示项，没有工具开关。
 *   · 工具无法注销（docs/extensions.md:160），官方推荐路径就是 pi.setActiveTools()（examples/extensions/tools.ts）。
 *
 * 时序：注册即激活（exposure: direct），所以必须在「工具已注册之后」再摘。
 *   session_start 与 before_agent_start 两处都挂，且幂等 ——
 *   取决于 pi 的扩展加载顺序，session_start 时 pi-tasks 可能还没注册完，
 *   before_agent_start 是每轮请求前的兜底，那时一定注册完了。
 *   pi-tasks 自身不调用 setActiveTools（已核对 dist/index.js），不会覆盖回来。
 *
 * 摘掉的效果：模型看不到这些工具的声明（也不再注入它们的 promptGuidelines），
 *   pi-web 工具面板也不再列出。恢复：把名字从 PRUNED 里删掉即可，无需其它改动。
 *
 * 回滚：删掉本文件 + 从 pi-suite/index.ts 的 MODULES 里去掉一行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 要摘掉的工具名。TaskCreate / TaskList / TaskUpdate 有意保留。 */
const PRUNED: readonly string[] = ["TaskGet", "TaskOutput", "TaskStop", "TaskExecute"];

export default function toolPrune(pi: ExtensionAPI) {
  let logged = false;

  const prune = (): void => {
    try {
      const active = pi.getActiveTools() as string[];
      const next = active.filter((name) => !PRUNED.includes(name));
      if (next.length === active.length) return; // 没有变化就不动，避免多余的会话条目
      pi.setActiveTools(next);
      if (!logged) {
        logged = true;
        const removed = active.filter((name) => PRUNED.includes(name));
        console.error(`[tool-prune] 已摘掉未使用的工具：${removed.join(", ")}`);
        try {
          pi.appendEntry("tool-prune", {
            removed,
            at: new Date().toISOString(),
          });
        } catch {
          /* 记不上不影响功能 */
        }
      }
    } catch (err: any) {
      console.error(`[tool-prune] 摘除失败（不影响其它功能）：${String(err?.message ?? err)}`);
    }
  };

  pi.on("session_start", async () => prune());
  pi.on("before_agent_start", async () => prune());
}
