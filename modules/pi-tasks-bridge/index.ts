/**
 * pi-tasks-bridge — 将 @tintinweb/pi-tasks 的子代理路径接到 billion-context-pi 的 delegate 机制
 *
 * 背景：
 *  - @tintinweb/pi-tasks 的 TaskExecute 通过 pi.events 总线做 RPC，协议要求存在一个
 *    "subagents" 实现（官方为 @tintinweb/pi-subagents），协议 v2：
 *      * subagents:rpc:ping   → subagents:rpc:ping:reply:<id> {success:true, data:{version:2}}
 *      * subagents:rpc:spawn  → subagents:rpc:spawn:reply:<id> {success:true, data:{id}}
 *      * subagents:rpc:stop   → subagents:rpc:stop:reply:<id> {success:true}
 *      * 完成时 emit subagents:completed {id, result}
 *      * 失败时 emit subagents:failed {id, error, result, status}   (status:"stopped"=按完成处理)
 *  - billion-context-pi 自带 acp_delegate 工具（spawn 独立 pi 子进程做子代理，~600 tok 开销），
 *    但其 AGENTS/runDelegate 未导出。因此本桥接自包含复制其 spawn 逻辑，
 *    agent type 复用它预置的 reviewer/researcher/worker/planner/oracle 角色与工具限制，
 *    未知类型（general-purpose/Explore 等）默认全工具。
 *
 * 安装位置：~/.pi/agent/extensions/pi-tasks-bridge/index.ts（自动发现，/reload 生效）
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 常量（与 billion-context-pi 保持一致）
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 2;
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"];
const RESTRICTED_TOOLS = "read,bash,grep,find,ls";

/** billion-context-pi 预置 agent 角色定义（自包含复制，避免依赖其未导出的内部） */
const AGENTS: Record<string, { tools: string; restricted: boolean; prompt: string }> = {
  reviewer: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a senior code reviewer with read-only access.
Read the given code and report: bugs, security/safety risks, correctness issues, and concrete improvement suggestions.
Be specific — cite file:line for every finding. Do NOT modify any files; only read and report.`,
  },
  researcher: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a code researcher with read-only access.
Investigate the codebase to answer the question thoroughly. Report findings with exact file:line references, function/type signatures, and relevant code snippets.
Do NOT modify any files; only read and report.`,
  },
  worker: {
    tools: "read,edit,write,bash",
    restricted: false,
    prompt: `You are a precise implementer.
Make exactly the requested code changes — minimal, focused, following existing project conventions (check AGENTS.md first if present).
After editing, briefly summarize what you changed and why. Do not expand scope.`,
  },
  planner: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a technical planner with read-only access.
Analyze the task and produce a concrete, ordered step-by-step implementation plan with rationale for each step.
Cite file:line for code you reference. Do NOT modify any files; only read and propose.`,
  },
  oracle: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are an expert advisor with read-only access.
Answer the question concisely with clear reasoning. Cite file:line when referencing code. Do NOT modify any files.`,
  },
};

/** 未知 agentType（pi-tasks 的 TaskCreate 默认 general-purpose、Explore 等）→ 全工具 + 通用角色 */
const DEFAULT_AGENT_PROMPT = `You are a subagent spawned to execute a delegated task.
Work autonomously in the given working directory. When you finish, report what you did and the outcome concisely.`;

const PI_CLI_ENTRY_RE = /[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/;
const PI_PACKAGE_REL = path.join("@earendil-works", "pi-coding-agent", "dist", "cli.js");

/** 看门狗（阈值镜像 billion-context-pi：闲置 5m / 总时限 30m） */
const IDLE_GRACE_MS = 5 * 60_000;
const ASYNC_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const MAX_DEPTH = 2;

// ---------------------------------------------------------------------------
// CLI 入口解析（billion-context-pi 同款）
// ---------------------------------------------------------------------------

function probeUpFromArgv(argv1: string): string | null {
  let dir = path.resolve(path.dirname(argv1) || process.cwd());
  for (;;) {
    const candidate = path.join(dir, "node_modules", PI_PACKAGE_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function piCliGlobalCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, "npm", "node_modules", PI_PACKAGE_REL));
  } else {
    const home = env.HOME ?? env.USERPROFILE;
    if (home) candidates.push(path.join(home, ".local", "lib", "node_modules", PI_PACKAGE_REL));
    candidates.push(path.join("/usr/local", "lib", "node_modules", PI_PACKAGE_REL));
    candidates.push(path.join("/usr", "lib", "node_modules", PI_PACKAGE_REL));
  }
  return candidates;
}

function resolvePiCliEntry(argv1: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CLI_PATH) return env.PI_CLI_PATH;
  if (argv1 && PI_CLI_ENTRY_RE.test(argv1)) return argv1;
  const probed = probeUpFromArgv(argv1);
  if (probed) return probed;
  for (const candidate of piCliGlobalCandidates(env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return argv1;
}

// ---------------------------------------------------------------------------
// 子进程 JSON 事件流解析（只收集最终回复文本）
// ---------------------------------------------------------------------------

function parseEventLine(line: string): { kind: string; delta?: string; content?: string } | null {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof ev !== "object" || ev === null) return null;
  if (ev.type === "message_update") {
    const am = ev.assistantMessageEvent;
    if (typeof am !== "object" || am === null) return null;
    switch (am.type) {
      case "text_delta":
        return { kind: "reply-delta", delta: String(am.delta ?? "") };
      case "text_end":
        return { kind: "reply-complete", content: String(am.content ?? "") };
      default:
        return null;
    }
  }
  return null;
}

function makeReplyCollector() {
  let replyText = "";
  return {
    handle(line: string) {
      const ev = parseEventLine(line);
      if (!ev) return;
      if (ev.kind === "reply-delta") replyText += ev.delta ?? "";
      else if (ev.kind === "reply-complete") replyText = ev.content ?? "";
    },
    get: () => replyText,
  };
}

// ---------------------------------------------------------------------------
// 运行中的 delegate 记录
// ---------------------------------------------------------------------------

interface Run {
  id: string; // agentId（与 billion-context-pi 的 runId 同格式）
  child: ChildProcess;
  task: string;
  settled: boolean;
  stopped: boolean; // stop RPC 已主动请求终止
  finalize: (code: number | null, killed: boolean, killReason?: string) => void;
}

const runs = new Map<string, Run>();

// ---------------------------------------------------------------------------
// 扩展主逻辑
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  /** 最近一次 session_start 的上下文（提供 cwd / model / mode / sessionManager） */
  let latestCtx: ExtensionContext | null = null;
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  function isPiHost(): boolean {
    const sm = (latestCtx as any)?.sessionManager;
    return typeof sm?.buildContextEntries === "function";
  }

  // ---- RPC: ping（协议握手，version=2 表示完全兼容）----
  pi.events.on("subagents:rpc:ping", (data: any) => {
    const requestId = data?.requestId;
    if (!requestId) return;
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version: PROTOCOL_VERSION },
    });
  });

  // ---- RPC: spawn（核心：启动独立 pi 子进程执行任务）----
  pi.events.on("subagents:rpc:spawn", async (data: any) => {
    const requestId = data?.requestId;
    const type = String(data?.type ?? "general-purpose");
    const prompt = String(data?.prompt ?? "");
    const options = (data?.options ?? {}) as {
      description?: string;
      isBackground?: boolean;
      maxTurns?: number;
      model?: string;
      cwd?: string;
    };
    const reply = (payload: unknown) => {
      if (requestId) pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, payload);
    };

    try {
      if (!prompt.trim()) {
        reply({ success: false, error: "Task prompt must be a non-empty string" });
        return;
      }
      // 深度保护：子代理内若再嵌套，最多 MAX_DEPTH 层
      const parentDepth = Number(process.env.PI_ACP_DELEGATE_DEPTH ?? "0");
      if (Number.isNaN(parentDepth) || parentDepth >= MAX_DEPTH) {
        reply({ success: false, error: `Delegate nesting limit reached (depth ${parentDepth}, max ${MAX_DEPTH})` });
        return;
      }

      const agentDef = AGENTS[type];
      const rolePrompt = agentDef?.prompt ?? DEFAULT_AGENT_PROMPT;
      const ctx = latestCtx ?? undefined;
      const cwd = (options.cwd && options.cwd.trim()) || ctx?.cwd || process.cwd();

      // ---- 构建 CLI 参数（billion-context-pi buildChildArgs 同款）----
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-delegate-"));
      const promptFile = path.join(tmpDir, "role.md");
      fs.writeFileSync(promptFile, `${rolePrompt}\n\n---\n\nComplete the task below.`, "utf8");

      const isAsync = ctx?.mode !== "print" && ctx?.mode !== "json";
      const useJsonStream = isAsync && isPiHost();
      const cliArgs = useJsonStream
        ? ["--mode", "json", "--no-session", "--append-system-prompt", promptFile]
        : ["-p", "--no-session", "--append-system-prompt", promptFile];
      if (agentDef?.restricted) {
        const merged = [...new Set([...agentDef.tools.split(",").map((s) => s.trim()), ...ACP_TOOLS])];
        cliArgs.push("--tools", merged.join(","));
      }
      if (options.model && options.model.includes("/")) {
        const idx = options.model.indexOf("/");
        cliArgs.push("--provider", options.model.slice(0, idx), "--model", options.model.slice(idx + 1));
      } else if ((ctx as any)?.model?.provider && (ctx as any)?.model?.id) {
        cliArgs.push("--provider", (ctx as any).model.provider, "--model", (ctx as any).model.id);
      }

      // ---- spawn 子进程 ----
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PI_ACP_DELEGATE_DEPTH: String(parentDepth + 1),
      };
      const cliEntry = resolvePiCliEntry(process.argv[1] ?? "", process.env);
      const child = spawn(process.execPath, [cliEntry, ...cliArgs], {
        cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      child.stdin?.once("error", () => {});
      child.stdin?.end(prompt);

      const agentId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      // ---- 结果收集与生命周期 ----
      let stderrText = "";
      let stdoutBuf = "";
      let replyText = "";
      const collector = makeReplyCollector();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
      }, ASYNC_TIMEOUT_MS);
      timeoutTimer.unref?.();
      const poke = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
        }, IDLE_GRACE_MS);
        idleTimer.unref?.();
      };
      poke();

      child.stdout?.on("data", (c: Buffer) => {
        poke();
        if (useJsonStream) {
          stdoutBuf += c.toString("utf8");
          let nl: number;
          while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            collector.handle(line);
          }
        } else {
          replyText += c.toString("utf8");
        }
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderrText += c.toString("utf8");
      });

      const finalize = (code: number | null, killed: boolean, killReason?: string) => {
        const run = runs.get(agentId);
        if (!run || run.settled) return;
        run.settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}

        if (run.stopped) {
          // 主动 stop：走 failed(status:"stopped")，保留部分结果（pi-tasks 按完成处理）
          const text = useJsonStream ? collector.get() : replyText;
          pi.events.emit("subagents:failed", {
            id: agentId,
            error: "stopped",
            result: text.trim() || undefined,
            status: "stopped",
          });
          runs.delete(agentId);
          return;
        }

        const text = useJsonStream ? collector.get() : replyText;
        const body =
          code === 0 ? text.trim() || "(no output)" : stderrText.trim() || text.trim() || `exit code ${code}`;
        if (code === 0 && !killed) {
          pi.events.emit("subagents:completed", { id: agentId, result: body });
        } else {
          pi.events.emit("subagents:failed", {
            id: agentId,
            error: killReason || (killed ? "killed" : stderrText.trim() || `exit code ${code}`),
            result: text.trim() || undefined,
            status: "failed",
          });
        }
        runs.delete(agentId);
      };

      const run: Run = { id: agentId, child, task: prompt, settled: false, stopped: false, finalize };
      runs.set(agentId, run);

      child.on("close", (code) => finalize(code, false));
      child.on("error", (err) => finalize(null, true, err.message));

      // spawn 成功，立即回包返回 agentId（pi-tasks 据此建立 agentTaskMap 映射）
      reply({ success: true, data: { id: agentId } });
    } catch (err: any) {
      reply({ success: false, error: String(err?.message ?? err) });
    }
  });

  // ---- RPC: stop（终止运行中的子代理）----
  pi.events.on("subagents:rpc:stop", (data: any) => {
    const requestId = data?.requestId;
    const agentId = data?.agentId;
    const reply = (payload: unknown) => {
      if (requestId) pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, payload);
    };
    const run = agentId ? runs.get(String(agentId)) : undefined;
    if (!run) {
      reply({ success: true });
      return;
    }
    try {
      run.stopped = true;
      run.child.kill("SIGTERM");
      const kt = setTimeout(() => {
        try {
          run.child.kill("SIGKILL");
        } catch {}
      }, KILL_GRACE_MS);
      kt.unref?.();
      reply({ success: true });
    } catch (err: any) {
      reply({ success: false, error: String(err?.message ?? err) });
    }
  });

  // ---- RPC: ready 提示（pi-tasks 加载后主动询问一次协议版本）----
  pi.events.emit("subagents:ready", {});
}