# pi-suite

A bundle of [pi](https://github.com/earendil-works/pi) coding-agent extensions that keep an
agent's output honest, its context cheap, and its file operations safe.

Each module is a plain pi extension: a default-exported factory receiving `pi` (the
`ExtensionAPI`). `index.ts` imports all of them and registers them from a single factory,
so you install one directory instead of eight.

> 中文说明见 [README.zh-CN.md](./README.zh-CN.md).

## Modules

| Module | What it does | Default |
|---|---|---|
| `hard-rules` | Blocks two zero-ambiguity, high-cost mistakes: reading `.pdf/.docx/.pptx/.xlsx` directly instead of converting to markdown first, and running an image-generation command without an explicit model argument. Also rewrites/removes boilerplate and chain-of-thought leakage from outgoing replies (rules ④ ⑤ J1 R7 H1–H3). | on |
| `multistep-gate` | Classifies each user turn as single-step or multi-step (regex first, Jev classifier as fallback) and injects the matching instruction block. | on |
| `skill-gate` | Routes a request to a skill before the turn is submitted: two-stage choice over the skill roster, rewrites the message to `/skill:<name>` when confident. | on |
| `rules-hooks` | Mechanical guards mapped from an `AGENTS.md`: jargon-without-explanation, unrequested steps, invented numbers, missing doc-read receipts. | on |
| `session-file-audit` | Audits file operations against the session's own history — catches destructive commands, aliased/junction paths, and protected files. | on |
| `tool-prune` | Prunes oversized tool output before it reaches the context. | on |
| `image-offload` | Moves image reads into a nested sub-agent so image bytes never enter the main conversation, keeping the prompt cache intact. | on |

## Install

Copy the whole directory into your pi extensions folder:

```bash
git clone <this-repo> ~/.pi/agent/extensions/pi-suite
```

Then `/reload` in pi (or restart it). Verify with `/hard-rules`, `/rules-hooks`, and
`/multistep-gate`.

Every module reads its files relative to the pi agent directory, which defaults to
`~/.pi/agent` and can be overridden:

```bash
export PI_AGENT_DIR=/path/to/.pi/agent
```

## Configuration

All modules degrade safely: if a config file is missing or unparseable, built-in
minimal defaults are used and the extension keeps working.

| Variable | Used by | Purpose |
|---|---|---|
| `PI_AGENT_DIR` | all | Root for logs, state files and key files. Default `~/.pi/agent`. |
| `PI_HARD_RULES_CONFIG` | `hard-rules` | Path to your own `rules-config.json` (word lists + thresholds). |
| `PI_HARD_RULES_LOG` | `hard-rules` | Override the JSONL log path. |
| `PI_RULES_HOOKS` | `rules-hooks` | `off` disables entirely, `advise` only records, default `on`. |
| `PI_MULTISTEP_LOG`, `PI_MULTISTEP_THRESHOLD`, `PI_MULTISTEP_KEY_FILE` | `multistep-gate` | Log path, decision threshold, API key file. |
| `PI_SKILL_GATE`, `PI_SKILL_GATE_MODE`, `PI_SKILL_GATE_KEY_FILE` | `skill-gate` | Switch, `load`/`advise` mode, key file. |
| `TYPESAFE_API_KEY` | `multistep-gate`, `skill-gate` | API key, takes precedence over the key file. |

### Tuning the word lists

`modules/hard-rules/rules-config.json` holds every word list and threshold used by
`hard-rules` — the tail-phrase list, chain-of-thought phrases, jargon→plain map, and the
three "no-information sentence" categories. Copy it, edit it, then point
`PI_HARD_RULES_CONFIG` at your copy:

```bash
cp modules/hard-rules/rules-config.json ~/.pi/hard-rules.json
export PI_HARD_RULES_CONFIG=~/.pi/hard-rules.json
```

`requiredModel` is a placeholder (`your-image-model`) — set it to whatever model your own
image-generation command requires.

### rules-hooks is a worked example

`rules-hooks.ts` maps one specific `AGENTS.md` into mechanical guards. Rule H9 (image
generation must pass a particular `-Model`) and the H4 jargon list are written for that
setup. **Adapt them to your own conventions, or disable the module** with
`PI_RULES_HOOKS=off`. Everything else in the module is generic.

## Development

Modules are plain ES modules / TypeScript files with no build step — pi loads them
directly.

```bash
bun modules/hard-rules/test.mjs          # 199 cases
bun modules/session-file-audit/test.mjs  # 117 cases
```

The word-list drift test inside `hard-rules` compares the compiled word lists against an
external rubric document and is skipped unless you point `PI_RUBRIC_MD` at one.

## License

MIT — see [LICENSE](./LICENSE).
