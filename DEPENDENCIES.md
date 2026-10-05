# External Dependencies and Substitutes

pi-suite has **no third-party npm dependencies** — every module imports only `node:*`
built-ins and the pi extension API (`@earendil-works/pi-coding-agent`).

However, several modules need **external capabilities** (an AI classifier, a vision model,
an image-generation CLI convention…). These cannot be satisfied by `npm install`; you have
to supply an equivalent yourself. This document lists each one and what it can be swapped for.

> Design rule: **a missing external capability must never break pi.** Every module
> fail-opens or degrades — the "Without it" column states the outcome.

---

## 1. AI classifier (Typesafe Jev)

Two modules use the same classifier service to turn natural language into structured judgments:

| | |
|---|---|
| Endpoint | `https://api.typesafe.ai/v1/systemone` |
| Model | `jev-latest` |
| Auth | channel ① resolved by pi's auth layer; channel ② `<agent-dir>/.typesafe_key.txt` or env `TYPESAFE_API_KEY` |
| Channels | ① `ctx.modelRegistry.classify()` (**preferred, same source as pi's built-in**) → ② self-read key + direct HTTP |

### 1.1 `multistep-gate` — single-step vs. multi-step classification

Each user turn goes through a **regex first**; Jev is only consulted when the regex is inconclusive.

| | |
|---|---|
| **Without it** | ✅ **Still works.** Returns `{error:"no key"}`, but the regex result still applies — inconclusive input just falls back to the conservative branch |
| **Substitutes** | ① **Do nothing** — regex-only, nothing breaks<br>② Point at any compatible API: change `DEFAULTS.endpoint` / `model` in `judge.mjs`, or set `PI_MULTISTEP_ENDPOINT`<br>③ Plug in a local model: replace the body of `callOnce()` — it only POSTs a JSON body and parses a structured reply |

### 1.2 `skill-gate` — skill-routing gate

Two-stage choice: a choice over all skills to take the top-3, then a second choice over
top-3 + none.

| | |
|---|---|
| **Without it** | ⚠️ **Module is inert** (degrades to `{skill:null}` — it never rewrites the message). **No regex fallback** |
| **Substitutes** | ① Configure a key and use the official channel (easiest)<br>② Point `ENDPOINT` / `MODEL` in `gate.mjs` at any API supporting the same choice semantics<br>③ **Drop it**: remove `["skill-gate", skillGate]` from `MODULES` in `index.ts` and invoke skills manually via `/skill:name` |

> Note: `gate.mjs` and `judge.mjs` default to *different* key files
> (overridable via `PI_SKILL_GATE_KEY_FILE`) — configure both.

---

## 2. Vision model (`image-offload`)

Transcribes images returned by `read` into text so image bytes never enter the main
conversation (preserving the prompt cache).

| | |
|---|---|
| Call mechanism | `ctx.modelRegistry.complete(ctx.model, …)` — **pi-native API, not an external service** |
| Real dependency | **The current session model must accept image input** |

| | |
|---|---|
| **Without it** | ✅ **fail-open**: model unavailable / throws / times out / returns empty → the image passes through unchanged; reading images never breaks |
| **Substitutes** | Any **vision-capable model** (local Ollama llava / qwen-vl etc. work, as long as pi's provider layer can call it) |
| **Explicit model** | `describeImages()` accepts `opts.model` / `opts.registry` for your own handle |
| **Disable** | `PI_IMAGE_OFFLOAD=0`, or `/imgraw` to pass originals through temporarily |

---

## 3. Sub-agents

> **Status: pi-suite depends on no sub-agent at all.**

There used to be three touchpoints — the `H7` rule in `rules-hooks` ("sub-agents must go
through `acp_delegate`"), `acp_delegate*` listed as action tools in
`multistep-gate/tasks-reconcile`, and the standalone `pi-tasks-bridge` RPC bridge — **all
removed**, because they bound to an `acp_delegate` tool supplied by a private extension.

### If you *want* sub-agent isolation

`image-offload` currently performs **one independent model call** (`modelRegistry.complete`
with `cacheRetention:none`) and deliberately avoids sub-agents: its only goal is keeping
image bytes out of the main transcript, and a single call is the lightest way.

For heavier isolation (e.g. a sub-agent doing multiple rounds over many images and returning
only a conclusion), **swap in pi's native `acp_delegate`**: replace `describeImages()` with
a dispatch to a `researcher` / `worker` sub-agent that reads the images and returns text only.

| Approach | Cost | Fits |
|---|---|---|
| Current (one `complete` call) | Minimal, fixed cold start | One/few images, description only |
| `acp_delegate` sub-agent | Extra system prompt + tool defs per call | Multi-round reasoning, batch images |

---

## 4. Personal rules and config

These are not "dependencies" but **personal content extracted from someone's `AGENTS.md`**.
The open-source copy keeps the mechanism; the content is replaceable.

| File | Content | How to replace |
|---|---|---|
| `modules/hard-rules/rules-config.json` | Hard-rule word lists / thresholds / action levels | Edit the JSON, or set `PI_HARD_RULES_CONFIG` to your copy |
| `modules/hard-rules/rules.mjs` | Rule engine (generic, no personal content) | No change needed |
| `modules/session-file-audit/.pi/sfa-protect.txt` | File protection list (sample contains personal path patterns like `ws-*/**/*.md`) | Edit it; delete it to disable protection |

---

## 5. Image-generation CLI convention (`rules-hooks` H9)

`rules-hooks` has a rule checking whether image-generation commands pass the model explicitly:

| Rule | Checks |
|---|---|
| `H9a` | Image-gen command must explicitly pass `-Model 'GPT Image 2.5 Flare'` |
| `H9b` | A config round without `-ClickConfirm` must run first |

Both bind to **one specific image-generation skill (monica)** and its CLI convention.

| | |
|---|---|
| **Without that skill** | Rules never fire (the command pattern doesn't match) — **harmless** |
| **Substitutes** | ① **Delete**: drop the H9a/H9b blocks from `rules-hooks.ts`<br>② **Rewrite**: replace the match strings with your own tool's convention |

---

## 6. pi-native APIs (**not** external dependencies)

Everything below ships with the pi extension SDK — present in any pi install, no substitute needed:

| API | Purpose |
|---|---|
| `pi.on(event, handler)` | Event hooks (`tool_result` / `tool_call` / `context` / `session_start` / `session_before_compact` / `session_shutdown`, …) |
| `pi.registerCommand(name, …)` | Registers `/files`, `/trash`, `/imgraw`, `/hard-rules`, … |
| `ctx.modelRegistry.classify()` | Classifier official channel (§1) |
| `ctx.modelRegistry.complete()` | Standalone model call (§2) |
| `ctx.ui.notify()` / `ctx.ui.setWidget()` | User notices (zero tokens, never enters context) |
| `ctx.sessionManager.getSessionId()` | Session identity |

---

## Quick reference

| Dependency | Modules | Without it | Substitute |
|---|---|---|---|
| Typesafe Jev classifier | `multistep-gate`, `skill-gate` | multistep **degrades to regex (usable)**; skill-gate **inert** | Regex / self-hosted compatible API / local small model / drop the module |
| Vision-capable model | `image-offload` | fail-open, images pass through | Any vision model (local Ollama works) |
| Sub-agent (`acp_delegate`) | **all removed** | — | Use pi-native `acp_delegate` if needed |
| Personal hard rules | `hard-rules` | Built-in defaults | Edit `rules-config.json` |
| File protection list | `session-file-audit` | Protection off | Edit `.pi/sfa-protect.txt` |
| monica image-gen convention | `rules-hooks` | Rules never fire, harmless | Delete or rewrite H9a/H9b |
| Private compaction tool | **all removed** (moved to pi-native `session_before_compact`) | — | — |
