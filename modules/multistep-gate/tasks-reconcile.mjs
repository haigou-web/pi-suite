/**
 * tasks-reconcile.mjs — 任务面板对账的纯逻辑（无 IO、不依赖 pi API，可单独 import 测试）
 *
 * 为什么需要它：
 *   @tintinweb/pi-tasks 自带的 <system-reminder> 提醒按「用户轮次」计数（只有 turn_start 才 +1），
 *   所以在一个轮次内连着跑几十个工具调用时，它的 gap 恒为 0，永远不触发；
 *   等它触发时，用户已经在追问「为什么没更新任务」了。
 *   本模块改用「动作类工具调用次数 + 距上次碰任务面板的时长」计数，所以轮内就会触发。
 *
 * 计数规则：
 *   · 任务工具（TaskCreate/TaskUpdate/TaskList/TaskGet）→ 视为「碰过面板」：清零动作计数、记录时间、解除本轮已提醒
 *   · 动作类工具（powershell/bash/edit/write/acp_delegate 系列/TaskExecute/TaskOutput）→ 动作计数 +1
 *   · 其它工具（read/grep/compress/search_context…）→ 不计（纯侦察不算「干活」）
 *
 * 触发规则（evaluate）：
 *   面板存在未完成任务 且 本轮未提醒过 且 过了跨轮冷却 且
 *   （ 动作计数 ≥ hardActionCalls                                        → 硬阈值，不等时长
 *     或 动作计数 ≥ minActionCalls 且 距上次碰面板 ≥ minSinceTouchMs ）  → 常规阈值
 */

/** 碰过任务面板的工具名（上游 pi-tasks 的 TASK_TOOL_NAMES 同口径） */
export const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

/** 算「干活」的工具名：改文件 / 执行命令 / 起子代理 */
export const ACTION_TOOL_NAMES = new Set([
  "powershell",
  "bash",
  "edit",
  "write",
  "acp_delegate_wait",
  "acp_delegate_cancel",
  "TaskExecute",
  "TaskOutput",
]);

export const DEFAULT_CFG = {
  /** 常规阈值：动作类工具调用次数 */
  minActionCalls: 10,
  /** 硬阈值：不管时长，达到就提醒 */
  hardActionCalls: 25,
  /** 常规阈值附加条件：距上次碰面板至少这么久 */
  minSinceTouchMs: 5 * 60 * 1000,
  /** 跨轮冷却：两次提醒至少间隔这么久，避免连续唠叨 */
  cooldownMs: 10 * 60 * 1000,
  /** 提醒里最多回显几个任务（防长列表把提醒撑大） */
  maxTasksInReminder: 10,
};

export function createReconcileState() {
  return {
    /** 距上次碰面板的累计动作类工具调用次数 */
    actionCalls: 0,
    /** 上次碰面板的时间戳（ms）；0 表示本进程内从没碰过 */
    lastTouchAt: 0,
    /** 本轮是否已提醒过 */
    injectedThisTurn: false,
    /** 上次注入提醒的时间戳（ms），用于跨轮冷却 */
    lastInjectAt: 0,
    /** 累计注入次数（供日志/自检） */
    injectedTotal: 0,
  };
}

/** 每轮开始：清零本轮计数（冷却不重置，避免跨轮唠叨） */
export function onTurnStart(state) {
  state.actionCalls = 0;
  state.injectedThisTurn = false;
  return state;
}

/**
 * 记录一次 tool_result。
 * @returns {{kind:"touch"|"action"|"other", actionCalls:number}}
 */
export function noteToolResult(state, toolName, nowMs) {
  const name = typeof toolName === "string" ? toolName : "";
  if (TASK_TOOL_NAMES.has(name)) {
    state.actionCalls = 0;
    state.lastTouchAt = Number.isFinite(nowMs) ? nowMs : Date.now();
    state.injectedThisTurn = false;
    return { kind: "touch", actionCalls: 0 };
  }
  if (ACTION_TOOL_NAMES.has(name)) {
    state.actionCalls += 1;
    return { kind: "action", actionCalls: state.actionCalls };
  }
  return { kind: "other", actionCalls: state.actionCalls };
}

/**
 * 判定现在该不该注入提醒。
 * @param {object} state 由 createReconcileState 创建
 * @param {number} unfinishedCount 面板里未完成（pending/in_progress）的任务数
 * @param {object} [cfg]
 * @param {number} [nowMs]
 * @returns {{inject:boolean, reason:string, actionCalls:number, sinceTouchMs:number}}
 */
export function evaluate(state, unfinishedCount, cfg = DEFAULT_CFG, nowMs = Date.now()) {
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  const sinceTouchMs = state.lastTouchAt > 0 ? nowMs - state.lastTouchAt : Number.POSITIVE_INFINITY;
  const base = { actionCalls: state.actionCalls, sinceTouchMs };

  if (!(unfinishedCount > 0)) return { inject: false, reason: "no-unfinished-tasks", ...base };
  if (state.injectedThisTurn) return { inject: false, reason: "already-injected-this-turn", ...base };
  if (state.lastInjectAt > 0 && nowMs - state.lastInjectAt < c.cooldownMs) {
    return { inject: false, reason: "cooldown", ...base };
  }
  if (state.actionCalls >= c.hardActionCalls) return { inject: true, reason: "hard-threshold", ...base };
  if (state.actionCalls >= c.minActionCalls && sinceTouchMs >= c.minSinceTouchMs) {
    return { inject: true, reason: "threshold", ...base };
  }
  return { inject: false, reason: "below-threshold", ...base };
}

/** 记录「本轮已提醒」并清零计数 */
export function markInjected(state, nowMs) {
  state.injectedThisTurn = true;
  state.lastInjectAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  state.actionCalls = 0;
  state.injectedTotal += 1;
  return state;
}

function collapse(s) {
  return String(s ?? "").replace(/[\r\n]+/g, " ").replace(/<\/?task-reconcile>/gi, "").trim();
}

/**
 * 从存储文件的解析结果里取未完成任务。
 * @param {unknown} storeData { nextId, tasks: Task[] }
 * @returns {Array<{id:string, subject:string, status:string, updatedAt:number}>}
 */
export function unfinishedOf(storeData) {
  try {
    const tasks = storeData && Array.isArray(storeData.tasks) ? storeData.tasks : [];
    const rank = (s) => (s === "in_progress" ? 0 : s === "pending" ? 1 : 2);
    return tasks
      .filter((t) => t && typeof t === "object" && t.status !== "completed")
      .map((t) => ({
        id: String(t.id ?? "?"),
        subject: collapse(t.subject).slice(0, 80),
        status: String(t.status ?? "?"),
        updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
      }))
      .sort((a, b) => rank(a.status) - rank(b.status) || (Number(a.id) || 0) - (Number(b.id) || 0));
  } catch {
    return [];
  }
}

function minutesAgo(ts, nowMs) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const m = Math.round((nowMs - ts) / 60000);
  return m >= 0 ? m : null;
}

const STATUS_CN = { in_progress: "进行中", pending: "待办" };

/**
 * 生成注入文本。info: { actionCalls, sinceTouchMs, reason, nowMs, maxTasksInReminder }
 */
export function buildReminder(unfinished, info = {}) {
  const nowMs = Number.isFinite(info.nowMs) ? info.nowMs : Date.now();
  const maxN = Number.isFinite(info.maxTasksInReminder) ? info.maxTasksInReminder : DEFAULT_CFG.maxTasksInReminder;
  const list = Array.isArray(unfinished) ? unfinished : [];
  const shown = list.slice(0, maxN);

  const idleMin = Number.isFinite(info.sinceTouchMs) ? Math.round(info.sinceTouchMs / 60000) : null;
  const idle = idleMin === null ? "本进程内还没碰过任务面板" : `距上次碰任务面板 ${idleMin} 分钟`;

  const lines = shown.map((t) => {
    const age = minutesAgo(t.updatedAt, nowMs);
    const ageTxt = age === null ? "" : `（${age} 分钟未更新）`;
    const st = STATUS_CN[t.status] || t.status;
    return `- #${t.id} [${st}] ${t.subject}${ageTxt}`;
  });
  if (list.length > shown.length) lines.push(`- …另有 ${list.length - shown.length} 项未列出`);

  return [
    "<task-reconcile>",
    `[面板对账] 本次由扩展自动注入（理由 ${info.reason || "threshold"}）：动作类工具已调用 ${info.actionCalls ?? "?"} 次，${idle}；面板里还有 ${list.length} 项未完成：`,
    ...lines,
    "凡已完成的，现在就 TaskUpdate 标 completed；确实没动的，本轮回复最后一行说明原因（一句话）。不要向用户复述本条提醒。",
    "</task-reconcile>",
  ].join("\n");
}
