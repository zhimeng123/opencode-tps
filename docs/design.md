# opencode-tps — design

## Intent

Restore a live tokens-per-second (`tok/s`) readout in the OpenCode V2 TUI at the
right edge of the prompt footer. The original `@mesaleh/opencode-tps` is a V1 TUI
plugin and cannot run on V2, so this is an independent V2 implementation.

## Display (approved scope)

Four numbers, all for the current session:

| Field | Meaning | Scope |
|-------|---------|-------|
| `tok/s` | generation rate of the reply in flight, on OpenCode's terms | current turn |
| `avg` | mean of the values OpenCode prints for each reply | whole session |
| `↑` | peak burst rate | latest response |
| `↓` | floor burst rate | latest response |

While the session is idle, exactly `avg ↑… ↓…` is shown; the `tok/s` segment is
dropped rather than left as a placeholder.

## Non-goals

- No server-side plugin / no model transforms. TUI-only.
- No npm publication. Distribution is the public GitHub repo.
- No cross-session or cross-message history UI.

## Constraints

- OpenCode V2 plugin API: default export must be `{ id: string, setup(context) }`.
- Slot: `prompt.footer.status` (V2 renamed the V1 `session_prompt_right`).
- Events differ from V1: `session.text.delta`, `session.reasoning.delta`,
  `session.step.started` / `session.step.ended`, `session.tool.*`, `session.idle`.
- The API exposes no per-second token counts and no live token counts at all
  during a step, so the step in flight can only be estimated.

## What OpenCode itself does

Recovered from the `opencode-v2@2.0.32` binary (the readout is gated by the
`session.tps` CLI setting and is rendered once per turn, next to the duration):

```js
function co(messages) { return !messages.some((m) => m.type === "idle") }
function ga(messages, before, legacy) {
  let start = -1
  for (let i = before - 1; i >= 0; i--) {
    if (messages[i].type === "idle") return start
    if (messages[i].type !== "user" && messages[i].type !== "synthetic") continue
    if (legacy) return i
    start = i
  }
  return start
}
function fa(message, messages, index, legacy) {
  const before = index === -1 ? messages.length : index + 1
  const start = ga(messages, before, legacy)
  const turn = messages.slice(start + 1, before).filter((m) => m.type === "assistant")
  const spans = turn.flatMap((m) => m.time.streamed === undefined ? [] : [Math.max(0, m.time.streamed - m.time.created)])
  if (turn.length === 0 || spans.length !== turn.length) return undefined
  const tokens = turn.reduce((n, m) => n + (m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0), 0)
  const ms = spans.reduce((n, s) => n + s, 0)
  if (tokens <= 0 || ms <= 0) return undefined
  return tokens / (ms / 1000)
}
```

and the footer is emitted for an assistant message when
`finish && !["tool-calls", "unknown"].includes(finish) || error`, i.e. once per
turn, on the step that stops producing tool calls.

## Decisions

- **V2 module shape**: default-export a plain object (validated by `id` + `setup`),
  with type-only imports from `@opencode/plugin/tui`. Avoids a runtime dependency
  on the resolver-provided module.
- **Raw `src/tui.tsx` entry**: OpenCode transpiles the `./tui` export, so no build
  step is required.
- **`avg` is the mean of OpenCode's own readouts**: `turnRateAt` / `turnRates` are a
  direct port of `fa` / `ga` / `co`, including the `idle`-marker turn boundary and
  the legacy fallback to the nearest user message, so the footer reads on the same
  scale as the number OpenCode prints. Turns are **not** weighted by size — one
  short reply pulls the average as hard as one long one. On a real session the mean
  of the per-reply values was 89.0 tok/s where the old token-weighted average read
  25.6 tok/s.
- **`tok/s` is the same formula applied to the turn in flight**: banked steps
  (`currentTurnTotals`) contribute real `output + reasoning` tokens and real
  `streamed - created` time, the step in flight contributes estimated tokens
  measured only up to its latest delta. Because `session.step.started.started`
  is exactly the `time.created` OpenCode writes, and the last delta roughly
  matches `time.streamed`, the reading converges on OpenCode's value by the time
  the turn ends — which is when the reading is dropped anyway.
- **Estimates are acceptable here** (`~5.5 bytes per token`, the streaming text
  plus reasoning): the error only shows while streaming, and OpenCode's exact
  number replaces it in the transcript the moment the turn ends.
- **Latest response peak/floor stay burst extremes**: running extremes of the
  rolling-window reading, keyed by the streamed assistant message id and frozen on
  `session.idle`. The user asked for the positions and this meaning to be kept, so
  they intentionally do not follow the new `tok/s` family. Telemetry showed short
  responses arrive as two or three large deltas a few hundred ms apart, so the gate
  is "at least two samples and 250ms", not a multi-second warm-up.
- **Short responses**: if a response completes without a sampleable span, the
  peak/floor fall back to that response's real average rather than showing `-`.
- **Tool gaps excluded**: live samples are cleared on `session.tool.*`.
- **Duplicate events**: the event bus can deliver the same delta more than once;
  events are deduplicated by their stable `id`.
- **`avg` during a turn**: the turn in flight is not counted until it closes,
  matching OpenCode, which only prints the value once the reply is done.

## Verification

- Type-check against `@opencode/plugin@2.0.32`.
- `bun test` covers turn splitting (idle-bounded, legacy, tool-call steps merged),
  the unweighted mean, and the banked-totals helper.
- Confirm the plugin passes OpenCode's V2 module validator (loads without
  `Invalid V2 TUI plugin module`).
- Visual confirmation in the TUI is done by the maintainer, comparing the footer
  against the readout OpenCode prints in the transcript.
