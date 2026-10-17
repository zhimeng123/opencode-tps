# opencode-tps — design

## Intent

Restore a live tokens-per-second (`tok/s`) readout in the OpenCode V2 TUI at the
right edge of the prompt footer. The original `@mesaleh/opencode-tps` is a V1 TUI
plugin and cannot run on V2, so this is an independent V2 implementation.

## Display (approved scope)

Four numbers, all for the current session:

| Field | Meaning | Scope |
|-------|---------|-------|
| `tok/s` | current generation rate | live rolling window (5s) |
| `avg` | average generation rate | whole session |
| `↑` | peak rate | latest response |
| `↓` | floor rate | latest response |

Placeholder when there is nothing to show: `tok/s -`.

## Non-goals

- No server-side plugin / no model transforms. TUI-only.
- No npm publication. Distribution is the public GitHub repo.
- No cross-session or cross-message history UI.

## Constraints

- OpenCode V2 plugin API: default export must be `{ id: string, setup(context) }`.
- Slot: `prompt.footer.status` (V2 renamed the V1 `session_prompt_right`).
- Events differ from V1: `session.text.delta` (not `message.part.delta`),
  `session.tool.*`, `session.idle`.
- Live rate must be inferred from streamed text; the API exposes only per-message
  output-token totals.

## Decisions

- **V2 module shape**: default-export a plain object (validated by `id` + `setup`),
  with type-only imports from `@opencode/plugin/tui`. Avoids a runtime dependency
  on the resolver-provided module.
- **Raw `src/tui.tsx` entry**: OpenCode transpiles the `./tui` export, so no build
  step is required.
- **Session average**: real `tokens.output` summed over assistant messages divided
  by pure model time — `created → streamed`, i.e. the request round-trip stopping at
  the last streamed token. Verified against a tool-heavy session: this reads 31 tok/s
  where `completed - created` (which includes tool execution) reads 15 tok/s.
- **Latest response peak/floor**: running extremes of the live reading, keyed by
  the streamed assistant message id and frozen on `session.idle`. Telemetry showed
  short responses arrive as two or three large deltas a few hundred ms apart, so
  the gate is "at least two samples and 250ms", not a multi-second warm-up.
- **Short responses**: if a response completes without a sampleable span, the
  peak/floor fall back to that response's real average rather than showing `-`.
- **Tool gaps excluded**: live samples are cleared on `session.tool.*`.
- **Duplicate events**: the event bus can deliver the same `session.text.delta`
  more than once; events are deduplicated by their stable `id`.

## Verification

- Type-check against `@opencode/plugin@2.0.32`.
- Confirm the plugin passes OpenCode's V2 module validator (loads without
  `Invalid V2 TUI plugin module`).
- Visual confirmation in the TUI is done by the maintainer.
