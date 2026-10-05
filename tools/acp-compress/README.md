# acp-compress

A standalone helper — **not** a pi extension. Nothing here is loaded by `index.ts`.

It generates and applies the compression-prompt block used by ACP-style context
management: decide how much of a conversation range can be discarded, then emit the
prompt that asks a model to write the replacement summary.

## Files

| File | Role |
|---|---|
| `judge.mjs` | The decision logic. Maps a range's token count to a tier (L0–L4), each with a token budget, and applies "hard rule" floors that can only raise a tier. Also contains the optional Jev-based three-question scorer. |
| `apply-acp-prompts.mjs` | Writes the generated prompt block into a pi `acp.json`. |
| `selftest.mjs` | Self-test for the budget/tier mapping. |

## Usage

```bash
node judge.mjs --p2 24000        # which tier a 24K-token range lands in
bun selftest.mjs                 # 7 cases
```

`judge.mjs` can also call a classifier to score a range on three questions. That path
reads an API key from `<PI_AGENT_DIR>/.typesafe_key.txt` (or `TYPESAFE_API_KEY`); it is
never printed or logged.

The tier budgets and the hard-rule signals are intentionally conservative — the
per-range budget is a cap, and floors exist so that content containing secrets, ports,
thresholds or irreversible operations is never compressed away.
