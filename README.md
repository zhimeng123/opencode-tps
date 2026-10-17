# opencode-tps

A live **tokens-per-second** (`tok/s`) meter for the [OpenCode](https://opencode.ai) TUI, rendered at the right edge of the prompt footer.

```
tok/s 42.1  avg 35.8  ↑51.0  ↓12.3     # while a response is streaming
             avg 35.8  ↑51.0  ↓12.3     # once the session is idle
```

| Value | Meaning | Scope |
|-------|---------|-------|
| `tok/s` | current generation rate | live rolling window (shown only while streaming) |
| `avg` | average generation rate | whole session |
| `↑` | peak generation rate | latest response |
| `↓` | floor generation rate | latest response |

- The **live** number is smoothed over a rolling 5-second window and goes stale when no tokens arrive.
- The **average** uses real output-token counts (`tokens.output`) from completed responses over their generation time.
- The **peak/floor** track the latest response while it streams, then freeze so they stay readable until the next response starts.

The provider API does not expose per-second token counts, so live readings are inferred from streamed text (~5.5 bytes per token). Only time actually spent streaming counts toward the rate: tool calls are excluded, and a response that is too short to sample falls back to its real average so the peak/floor slots are not left empty.

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

1. accumulates `session.text.delta` events into a rolling sample window (estimated tokens + timestamp);
2. clears the live window on `session.tool.*` so tool-wait time is not counted as slow generation;
3. freezes the current response's peak/floor and drops the live window on `session.idle`;
4. reads real output-token counts from the session message list for the session average.

## Development

```sh
npm install
npx tsc --noEmit   # type-check against the OpenCode V2 plugin types
```

## License

MIT
