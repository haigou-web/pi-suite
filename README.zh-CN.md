# pi-suite

一组 [pi](https://github.com/earendil-works/pi) 编码 agent 扩展，用来让 agent 的输出更老实、上下文更省、文件操作更安全。

每个模块都是一个普通的 pi 扩展：默认导出一个工厂函数，接收 `pi`（`ExtensionAPI`）。`index.ts` 把它们全部 import 进来，由**一个**工厂统一注册——所以只装一个目录，而不是八个。

> English docs: [README.md](./README.md)

## 模块清单

| 模块 | 作用 | 默认 |
|---|---|---|
| `hard-rules` | 只拦两类「代价高、零歧义」的错：直接 read `.pdf/.docx/.pptx/.xlsx` 而不先转 markdown；生图命令没显式指定模型。同时清理回复里的客套收尾、思维链泄漏、行话与过渡语空转（规则 ④ ⑤ J1 R7 H1–H3）。 | 开 |
| `multistep-gate` | 把每一轮用户输入判成单步/多步（先正则，再用 Jev 分类器兜底），注入对应的指令块。 | 开 |
| `skill-gate` | 在消息提交前做技能路由：对技能清单做两段式 choice，置信够高就把消息改写成 `/skill:<name>`。 | 开 |
| `rules-hooks` | 把一份 `AGENTS.md` 里能机械判定的规则做成钩子：术语没解释、预演未要求的步骤、编数字、文档读取没给回执。 | 开 |
| `session-file-audit` | 拿会话自己的历史核对文件操作——拦破坏性命令、别名/junction 路径、受保护文件。 | 开 |
| `tool-prune` | 在超长工具输出进入上下文前先裁剪。 | 开 |
| `image-offload` | 把读图挪进嵌套子 agent，图片字节不进入主对话，从而保住 prompt 缓存。 | 开 |

## 安装

整个目录拷进 pi 扩展目录：

```bash
git clone <本仓库> ~/.pi/agent/extensions/pi-suite
```

然后在 pi 里 `/reload`（或重启）。用 `/hard-rules`、`/rules-hooks`、`/multistep-gate` 验证。

所有模块的文件路径都相对「pi agent 目录」解析，默认 `~/.pi/agent`，可覆盖：

```bash
export PI_AGENT_DIR=/path/to/.pi/agent
```

## 配置

所有模块都能安全降级：配置文件缺失或解析失败时，回退到内置最小默认值，扩展照常工作。

| 环境变量 | 用于 | 说明 |
|---|---|---|
| `PI_AGENT_DIR` | 全部 | 日志、状态文件、key 文件的根目录。默认 `~/.pi/agent`。 |
| `PI_HARD_RULES_CONFIG` | `hard-rules` | 指向你自己的 `rules-config.json`（词表 + 阈值）。 |
| `PI_HARD_RULES_LOG` | `hard-rules` | 覆盖 JSONL 日志路径。 |
| `PI_RULES_HOOKS` | `rules-hooks` | `off` 整体停用，`advise` 只记录，默认 `on`。 |
| `PI_MULTISTEP_LOG`、`PI_MULTISTEP_THRESHOLD`、`PI_MULTISTEP_KEY_FILE` | `multistep-gate` | 日志路径、判定阈值、key 文件。 |
| `PI_SKILL_GATE`、`PI_SKILL_GATE_MODE`、`PI_SKILL_GATE_KEY_FILE` | `skill-gate` | 开关、`load`/`advise` 模式、key 文件。 |
| `TYPESAFE_API_KEY` | `multistep-gate`、`skill-gate` | API key，优先级高于 key 文件。 |

### 调整词表

`modules/hard-rules/rules-config.json` 装着 `hard-rules` 用到的全部词表与阈值——客套收尾词表、思维链词表、行话→白话映射表，以及三类「无信息量句子」的词表。复制一份改成自己的，再用 `PI_HARD_RULES_CONFIG` 指过去：

```bash
cp modules/hard-rules/rules-config.json ~/.pi/hard-rules.json
export PI_HARD_RULES_CONFIG=~/.pi/hard-rules.json
```

`requiredModel` 是占位值（`your-image-model`），请改成你自己生图命令要求的模型名。

### rules-hooks 是一份示例

`rules-hooks.ts` 是把某一份具体的 `AGENTS.md` 映射成的机械守卫。规则 H9（生图必须带特定 `-Model`）和 H4 的术语表是按那套环境写的。**请按你自己的约定改写，或者整体关掉**（`PI_RULES_HOOKS=off`）。模块里其余部分是通用的。

## 开发

模块都是普通 ES module / TypeScript 文件，无需构建——pi 直接加载。

```bash
bun modules/hard-rules/test.mjs          # 199 例
bun modules/session-file-audit/test.mjs  # 117 例
```

`hard-rules` 里的「词表漂移测试」会把编译后的词表和一份外部 rubric 文档比对，除非你把 `PI_RUBRIC_MD` 指过去，否则自动跳过。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
