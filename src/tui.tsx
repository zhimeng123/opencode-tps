/** @jsxImportSource @opentui/solid */
import type { SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"

/**
 * opencode-tps — a live tokens-per-second meter for the OpenCode TUI.
 *
 * Rendered at the right edge of the prompt footer for the current session, it
 * shows four numbers while a response streams:
 *
 *   tok/s <now> avg <session> ↑<max> ↓<min>
 *
 * The "now" segment only exists while tokens are arriving; once the session is
 * idle the meter shows just:
 *
 *   avg <session> ↑<max> ↓<min>
 *
 *   - "now" is the live generation rate over a rolling window.
 *   - "avg" is the whole session's output tokens over model time only, i.e. from
 *     each request until its last streamed token; tool execution is excluded.
 *   - "max" is the peak rate of the most recent response.
 *   - "min" is the floor rate of the most recent response.
 *
 * The provider API exposes no per-second token counts, so live rates are
 * inferred from streamed text. When a response completes the live window is
 * dropped; its peak/floor stay frozen so they can be read afterwards.
 */

const SAMPLE_WINDOW_MS = 5000
const LIVE_STALE_MS = 1500
const MIN_RECORD_MS = 250
const SINGLE_SAMPLE_MIN_MS = 250
const SINGLE_SAMPLE_MAX_MS = 1000
const BYTES_PER_TOKEN = 5.5

type Sample = {
  tokens: number
  ts: number
}

type ResponseStats = {
  messageID: string
  firstDeltaTs: number
  maxTps: number
  minTps: number
  frozen: boolean
}

type SessionState = {
  samples: Sample[]
  response: ResponseStats
}

function newResponse(now: number, messageID: string): ResponseStats {
  return {
    messageID,
    firstDeltaTs: now,
    maxTps: Number.NEGATIVE_INFINITY,
    minTps: Number.POSITIVE_INFINITY,
    frozen: false,
  }
}

function newState(now: number): SessionState {
  return { samples: [], response: newResponse(now, "") }
}

function estimateTokens(text: string): number {
  const bytes = new TextEncoder().encode(text).length
  return Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN))
}

function formatTps(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "-"
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return Math.round(value).toString()
}

function activeDurationMs(samples: Sample[]): number {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    return Math.max(SINGLE_SAMPLE_MIN_MS, Math.min(Date.now() - samples[0].ts, SINGLE_SAMPLE_MAX_MS))
  }
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    total += Math.max(0, samples[i].ts - samples[i - 1].ts)
  }
  total += Math.min(Date.now() - samples[samples.length - 1].ts, 1000)
  return Math.max(total, SINGLE_SAMPLE_MIN_MS)
}

function liveTps(state: SessionState, status: "idle" | "running"): number {
  if (status === "idle") return -1
  const now = Date.now()
  const active = state.samples.filter((sample) => sample.ts >= now - SAMPLE_WINDOW_MS)
  if (active.length === 0) return -1
  if (now - active[active.length - 1].ts > LIVE_STALE_MS) return -1
  const duration = activeDurationMs(active)
  if (duration <= 0) return -1
  const tokens = active.reduce((sum, sample) => sum + sample.tokens, 0)
  return (tokens / duration) * 1000
}

/**
 * Update the current response's peak/floor from the live reading. Called on every
 * delta (so it cannot be missed between timer ticks) and on each tick. The very
 * first delta is skipped: a single chunk cannot be turned into a rate without a
 * duration, and providers can deliver an entire short response in a couple of
 * large chunks only a few hundred milliseconds apart.
 */
function recordPeakFloor(state: SessionState, now: number): void {
  if (state.response.frozen) return
  if (state.samples.length < 2) return
  if (now - state.response.firstDeltaTs < MIN_RECORD_MS) return
  const live = liveTps(state, "running")
  if (live <= 0) return
  if (live > state.response.maxTps) state.response.maxTps = live
  if (live < state.response.minTps) state.response.minTps = live
}

/**
 * Time the model actually spent producing one assistant message.
 *
 * `created → streamed` covers the request round-trip and token streaming but stops
 * at the last token, so tool execution that follows in the same turn (which is why
 * the message only reaches `completed` much later) does not count. When a provider
 * never reports `streamed`, fall back to the whole message lifetime.
 */
function modelDurationMs(time: { created: number; streamed?: number; completed?: number } | undefined): number {
  if (!time) return -1
  const created = time.created
  if (typeof created !== "number") return -1
  const streamed = time.streamed
  if (typeof streamed === "number" && streamed > created) return streamed - created
  const completed = time.completed
  if (typeof completed === "number" && completed > created) return completed - created
  return -1
}

/** Real model-only generation rate of a completed assistant message, or -1. */
function messageRate(message: SessionMessageInfo): number {
  if (message.type !== "assistant") return -1
  const output = message.tokens?.output
  if (typeof output !== "number" || output <= 0) return -1
  const durationMs = modelDurationMs(message.time)
  if (durationMs <= 0) return -1
  return (output / durationMs) * 1000
}

function sessionAverageTps(context: Context, sessionID: string): number {
  const messages = context.data.session.message.list(sessionID) ?? []
  let tokens = 0
  let durationMs = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const output = message.tokens?.output
    if (typeof output !== "number" || output <= 0) continue
    const modelMs = modelDurationMs(message.time)
    if (modelMs <= 0) continue
    tokens += output
    durationMs += modelMs
  }
  if (durationMs <= 0) return -1
  return (tokens / durationMs) * 1000
}

function latestResponseTps(context: Context, sessionID: string): number {
  const messages = context.data.session.message.list(sessionID) ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const rate = messageRate(messages[i])
    if (rate > 0) return rate
  }
  return -1
}

function themeColor(context: Context): RGBA | undefined {
  const text = context.theme?.text
  return text?.muted ?? text?.base
}

const plugin = {
  id: "opencode-tps",
  setup(context: Context) {
    const states = new Map<string, SessionState>()
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((value) => value + 1)

    const track = (sessionID: string, messageID: string, delta: string) => {
      if (!sessionID || typeof delta !== "string" || delta.length === 0) return
      const now = Date.now()
      let state = states.get(sessionID)
      if (!state) {
        state = newState(now)
        states.set(sessionID, state)
      }
      // Each assistant message is its own response. A session can flap to idle
      // between text blocks, so key the response on the message id instead of on
      // idle — otherwise the peak/floor get wiped by the final short block.
      if (state.response.messageID !== messageID) {
        state.response = newResponse(now, messageID)
        state.samples = []
      }
      state.samples.push({ tokens: estimateTokens(delta), ts: now })
      recordPeakFloor(state, now)
      bump()
    }

    const clearSamples = (sessionID: string) => {
      const state = states.get(sessionID)
      if (state && state.samples.length > 0) {
        state.samples = []
        bump()
      }
    }

    const finishResponse = (sessionID: string) => {
      const state = states.get(sessionID)
      if (!state) return
      state.response.frozen = true
      state.samples = []
      bump()
    }

    // The event bus can deliver the same event more than once; the id is stable,
    // so drop repeats rather than double-counting tokens.
    const seenEvents = new Set<string>()
    const unsubscribers: Array<() => void> = [
      context.data.on("session.text.delta", (event) => {
        const id = (event as { id?: string }).id
        if (id) {
          if (seenEvents.has(id)) return
          seenEvents.add(id)
          if (seenEvents.size > 8192) seenEvents.clear()
        }
        track(event.data.sessionID, event.data.assistantMessageID, event.data.delta)
      }),
      context.data.on("session.tool.called", (event) => clearSamples(event.data.sessionID)),
      context.data.on("session.tool.success", (event) => clearSamples(event.data.sessionID)),
      context.data.on("session.tool.failed", (event) => clearSamples(event.data.sessionID)),
      context.data.on("session.idle", (event) => finishResponse(event.data.sessionID)),
    ]

    const interval = setInterval(() => {
      try {
        const now = Date.now()
        for (const [sessionID, state] of states) {
          state.samples = state.samples.filter((sample) => sample.ts >= now - SAMPLE_WINDOW_MS)
          if (context.data.session.status(sessionID) === "idle") continue
          recordPeakFloor(state, now)
        }
      } catch {
        // A failed data read must never tear down the ticker.
      }
      bump()
    }, 1000)

    const dispose = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID
        const color = themeColor(context)
        const display = createMemo(() => {
          version()
          if (!sessionID) return ""
          const state = states.get(sessionID)
          const status = context.data.session.status(sessionID)
          const live = state ? liveTps(state, status) : -1
          const average = sessionAverageTps(context, sessionID)
          let max = state?.response.maxTps ?? -1
          let min = state?.response.minTps ?? -1
          // A response can be too short to sample a peak/floor. Once it is idle,
          // fall back to its real average so the slots are not left empty.
          if ((!Number.isFinite(max) || !Number.isFinite(min)) && status === "idle") {
            const fallback = latestResponseTps(context, sessionID)
            if (fallback > 0) {
              if (!Number.isFinite(max)) max = fallback
              if (!Number.isFinite(min)) min = fallback
            }
          }
          // The live rate only has meaning while tokens are arriving; when idle
          // the whole segment is dropped rather than showing a placeholder.
          const parts: string[] = []
          if (live > 0) parts.push(`tok/s ${formatTps(live)}`)
          parts.push(`avg ${formatTps(average)}`)
          parts.push(`↑${formatTps(max)}`)
          parts.push(`↓${formatTps(min)}`)
          return parts.join(" ")
        })
        return <text fg={color}>{display()}</text>
      },
    })

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      clearInterval(interval)
      dispose()
    }
  },
}

export default plugin
