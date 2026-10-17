# opencode-tps

A live **tokens-per-second** (`tok/s`) meter for the [OpenCode](https://opencode.ai) TUI, rendered at the right edge of the prompt footer.

```
tok/s 88.9 avg 89.0 ↑163 ↓63.0     # while a response is streaming
avg 89.0 ↑163 ↓63.0                # once the session is idle
```

| Value | Meaning | Scope |
|-------|---------|-------|
| `tok/s` | generation rate of the reply in flight | current turn (shown only while streaming) |
| `avg` | average of the values OpenCode prints for each reply | whole session |
| `↑` | peak burst rate | latest response |
| `↓` | floor burst rate | latest response |

### Semantics

The four numbers come in two families, and the difference is deliberate.

**`tok/s` and `avg` speak OpenCode's language.** At the end of every reply OpenCode prints `· 1m 3s · 88.9 tok/s` in the transcript, computed as

```
(output + reasoning tokens) ÷ (created → streamed, summed over every step of the turn) × 1000
```

so tool execution and other waiting never count. `avg` is the **mean of those per-reply values** — each reply counts once, however many tokens it produced. `tok/s` is the same formula applied to the turn in flight: it is approximate while streaming, because the step in flight has to be estimated from the text that has arrived. Once the turn ends the meter drops `tok/s` and OpenCode's own exact number takes over in the transcript.

**`↑` and `↓` are burst extremes.** They describe how fast text actually poured out at its best and worst moment of the latest response, smoothed over a rolling 5-second window. They read much higher than the OpenCode-style values because they ignore time-to-first-token, stalls, tool gaps and reasoning.

- The live number goes stale after 1.5s without a delta; the whole segment is then dropped rather than showing a placeholder.
- The peak/floor track the latest response while it streams, then freeze so they stay readable until the next response starts.

The provider API exposes no per-second token counts, so the streaming estimate is inferred from the text that has arrived (~5.5 bytes per token). A response too short to sample falls back to its real average so the peak/floor slots are not left empty.

## Requirements

- OpenCode **V2** (`opencode --version` reports `2.x`).
- The OpenCode TUI. The web UI does not render this plugin.

## Install

Add it to the global CLI plugin list in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-tps@git+https://github.com/zhimeng123/opencode-tps.git"]
}
```

Restart the TUI. To install from a local checkout instead:

```json
{
  "plugins": ["/absolute/path/to/opencode-tps"]
}
```

Remove any V1 `tui.json` entry for this plugin — V1 TUI plugins do not run on V2.

### Updating

The CLI caches a git dependency by URL, so pushing to the repo is not enough on
its own. To pull a newer revision, pin the desired commit in the specifier:

```json
{ "plugins": ["opencode-tps@git+https://github.com/zhimeng123/opencode-tps.git#<commit>"] }
```

then delete the cached install under `~/.cache/opencode/npm/git-opencode-tps-*`
and restart the TUI.

## How it works

The plugin is a V2 TUI plugin: it default-exports a definition with an `id` and a `setup(context)` function and claims the `prompt.footer.status` slot.

It subscribes to the server event stream and:

1. accumulates `session.text.delta` and `session.reasoning.delta` into the turn in flight, so `tok/s` can be measured the way OpenCode measures it;
2. times the turn from `session.step.started` and banks each finished step on `session.step.ended`, so already-completed steps contribute their real token counts and the clock stops while a tool runs;
3. keeps a rolling sample window of the streamed *text* for the peak/floor, cleared on `session.tool.*` and frozen on `session.idle`;
4. walks the session message list to reproduce OpenCode's per-reply readout — turn boundaries are the `idle` marker every execution leaves behind — and averages those for `avg`.

## Development

```sh
npm install
bun test           # unit tests for the turn and average maths
npx tsc --noEmit   # type-check against the OpenCode V2 plugin types
```

## License

MIT
