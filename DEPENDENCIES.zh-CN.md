# 外部依赖与替代方案

pi-suite **没有任何第三方 npm 依赖**——所有模块只 import `node:*` 内置模块和 pi 扩展 API
（`@earendil-works/pi-coding-agent`）。

但有若干模块需要**外部能力**（AI 分类器、视觉模型、生图工具约定……）。这类依赖不是
「装个包」就能满足的，而是需要你自己提供一个等价物。本文逐项列出，并说明每项**可以
换成本地的什么**。

> 设计原则：**任何外部能力缺失都不应让 pi 起不来**。每个模块都 fail-open 或降级，
> 下面「无依赖时的行为」一列写明了降级结果。

---

## 一、AI 分类器（Typesafe Jev）

两个模块用同一个分类器服务做「自然语言 → 结构化判断」：

| 项 | 值 |
|---|---|
| 端点 | `https://api.typesafe.ai/v1/systemone` |
| 模型 | `jev-latest` |
| 认证 | 通道① 由 pi 认证层解析；通道② 读 `<agent-dir>/.typesafe_key.txt`，或环境变量 `TYPESAFE_API_KEY` |
| 通道选择 | ① `ctx.modelRegistry.classify()`（**优先，与 pi 内置通道同源**）→ ② 自读 key + HTTP 直连 |

### 1.1 `multistep-gate` —— 单步/多步判定

每轮用户输入先过**正则**，命中就直接判定；正则拿不准才问 Jev。

| | |
|---|---|
| **无依赖时的行为** | ✅ **仍可用**。返回 `{error:"no key"}`，但正则结果照常生效——只是拿不准的输入一律按保守档处理 |
| **本地替代** | ① **什么都不做**：纯正则，功能不坏<br>② 换成任意兼容 API：改 `judge.mjs` 的 `DEFAULTS.endpoint` / `model`，或设 `PI_MULTISTEP_ENDPOINT` 指向你的服务<br>③ 接本地小模型：替换 `callOnce()` 的实现即可（它只发一个 JSON body、读回结构化结果） |

### 1.2 `skill-gate` —— 技能路由闸门

两段式 choice：先对全部技能做一次 choice 取 top-3，再对 top-3 + none 做第二次 choice。

| | |
|---|---|
| **无依赖时的行为** | ⚠️ **该模块失效**（降级为 `{skill:null}`，即永不改写消息）。**没有正则兜底** |
| **本地替代** | ① 配 key 走官方通道（最省事）<br>② 改 `gate.mjs` 的 `ENDPOINT` / `MODEL` 指向任意支持同样 choice 语义的 API<br>③ **不用它**：从 `index.ts` 的 `MODULES` 里删掉 `["skill-gate", skillGate]`，技能改由你手动 `/skill:name` 调用 |

> 注意：`gate.mjs` 与 `judge.mjs` 的 key 文件默认不同（`PI_SKILL_GATE_KEY_FILE`
> 可覆盖），两处要分别配。

---

## 二、视觉模型（`image-offload`）

把 `read` 返回的图片**转写成文本**，让图片字节永不进入主会话（保住 prompt 缓存）。

| 项 | 值 |
|---|---|
| 调用方式 | `ctx.modelRegistry.complete(ctx.model, …)` —— **pi 原生 API，不是外部服务** |
| 真实依赖 | **当前会话的模型必须支持视觉输入** |

| | |
|---|---|
| **无依赖时的行为** | ✅ **fail-open**：模型不可用 / 抛错 / 超时 / 返回空 → 原样放行图片，读图功能不受影响 |
| **本地替代** | 用任意**支持视觉的本地模型**（Ollama 的 llava / qwen-vl 等均可，只要能通过 pi 的 provider 层调用） |
| **显式指定模型** | `describeImages()` 接受 `opts.model` / `opts.registry`，可传入你自己的模型句柄 |
| **关掉** | `PI_IMAGE_OFFLOAD=0`，或 `/imgraw` 临时放行原图 |

---

## 三、子 Agent

> **现状：pi-suite 已不依赖任何子 Agent。**

历史上有一处依赖（`rules-hooks` 的 H7 规则「子 Agent 一律走 `acp_delegate`」、
`multistep-gate/tasks-reconcile` 把 `acp_delegate*` 列为动作工具、以及独立的
`pi-tasks-bridge` RPC 桥），**均已移除**——它们绑定的是某个私有扩展提供的
`acp_delegate` 工具。

### 如果你想用子 Agent 隔离上下文

`image-offload` 目前的实现是「**一次独立的模型调用**」（`modelRegistry.complete`
+ `cacheRetention:none`），刻意不走子 Agent——因为它的目标只是把图片字节挡在主
transcript 之外，一次模型调用最轻。

但如果你希望更重的隔离（例如让子 Agent 自己多轮读图、只回结论），**可以换用 pi 原生
的 `acp_delegate`**：把 `describeImages()` 的实现替换为派发一个 `researcher` /
`worker` 子 Agent，让它读图后只返回文本结论。

| 方案 | 代价 | 适用 |
|---|---|---|
| 当前实现（一次 `complete` 调用） | 最小，固定冷启动 | 单张/少量图，只要文字描述 |
| 换成 `acp_delegate` 子 Agent | 每次多一份 system prompt + 工具定义 | 需要多轮推理、批处理多图 |

---

## 四、私有规则与配置

这些不是「依赖」，而是**从某个人的 `AGENTS.md` 抽出来的个人化内容**。开源版本保留
了机制、但内容可替换。

| 文件 | 内容 | 如何替换 |
|---|---|---|
| `modules/hard-rules/rules-config.json` | 硬规则词表 / 阈值 / 拦截档位 | 直接改这个 JSON；或设 `PI_HARD_RULES_CONFIG` 指向你的副本 |
| `modules/hard-rules/rules.mjs` | 规则引擎（通用，无个人内容） | 不用改 |
| `modules/session-file-audit/.pi/sfa-protect.txt` | 文件保护名单（示例含 `ws-*/**/*.md` 等个人路径模式） | 改这个文件；删掉它则保护功能关闭 |

---

## 五、生图工具约定（`rules-hooks` 的 H9）

`rules-hooks` 里有一条规则，检查生图命令是否显式带了模型参数：

| 规则 | 检查内容 |
|---|---|
| `H9a` | 生图命令必须显式带 `-Model 'GPT Image 2.5 Flare'` |
| `H9b` | 真跑前须先跑一次不带 `-ClickConfirm` 的配置轮 |

这两条绑定的是**某个特定生图技能（monica）的命令行约定**。

| | |
|---|---|
| **无该技能时的行为** | 规则不触发（因为命令模式根本不匹配），**无害** |
| **本地替代** | ① **删掉**：从 `rules-hooks.ts` 移除 H9a/H9b 两段<br>② **改**：把匹配串换成你自己的生图工具约定 |

---

## 六、pi 原生 API（**不是**外部依赖）

以下都是 pi 扩展 SDK 提供的，任何 pi 环境都有，无需替代：

| API | 用途 |
|---|---|
| `pi.on(event, handler)` | 事件挂钩（`tool_result` / `tool_call` / `context` / `session_start` / `session_before_compact` / `session_shutdown` 等） |
| `pi.registerCommand(name, …)` | 注册 `/files`、`/trash`、`/imgraw`、`/hard-rules` 等命令 |
| `ctx.modelRegistry.classify()` | 分类器官方通道（上文 §1） |
| `ctx.modelRegistry.complete()` | 独立模型调用（上文 §2） |
| `ctx.ui.notify()` / `ctx.ui.setWidget()` | 用户提示（零 token，不进上下文） |
| `ctx.sessionManager.getSessionId()` | 会话标识 |

---

## 速查表

| 依赖 | 涉及模块 | 缺了会怎样 | 本地替代 |
|---|---|---|---|
| Typesafe Jev 分类器 | `multistep-gate`, `skill-gate` | multistep **降级为正则可用**；skill-gate **失效** | 正则 / 自建兼容 API / 本地小模型 / 删模块 |
| 支持视觉的模型 | `image-offload` | fail-open，原样放行图片 | 任意视觉模型（本地 Ollama 亦可） |
| 子 Agent（`acp_delegate`） | **已全部移除** | — | 需要时用 pi 原生 `acp_delegate` |
| 个人化硬规则 | `hard-rules` | 用内置默认 | 改 `rules-config.json` |
| 文件保护名单 | `session-file-audit` | 保护关闭 | 改 `.pi/sfa-protect.txt` |
| monica 生图约定 | `rules-hooks` | 规则不触发，无害 | 删除或改写 H9a/H9b |
| 私有压缩工具 | **已全部移除**（改挂 pi 原生 `session_before_compact`） | — | — |
