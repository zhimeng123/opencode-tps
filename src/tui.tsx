/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"

/**
 * opencode-tps — a live tokens-per-second meter for the OpenCode TUI.
 *
 * Rendered at the right edge of the prompt footer for the current session, it
 * shows four numbers:
 *
 *   tok/s <now>   avg <session>   ↑<max>   ↓<min>
 *
 *   - "now"  is the live generation rate over a rolling window.
 *   - "avg"  is the whole session's output tokens over generation time.
 *   - "max"  is the peak rate of the most recent response.
 *   - "min"  is the floor rate of the most recent response.
 *
 * Rates are inferred from streamed text because the provider API exposes no
 * per-second token counts. When a response completes the live window is
 * dropped; the peak/floor stay frozen so they can be read after the fact.
 */

const SAMPLE_WINDOW_MS = 5000
const LIVE_STALE_MS = 1500
const WARMUP_MS = 3000
const SINGLE_SAMPLE_MIN_MS = 250
const SINGLE_SAMPLE_MAX_MS = 1000
const BYTES_PER_TOKEN = 5.5

type Sample = {
  tokens: number
  ts: number
}

type ResponseStats = {
  firstDeltaTs: number
  maxTps: number
  minTps: number
  frozen: boolean
}

type SessionState = {
  samples: Sample[]
  response: ResponseStats
}

function newResponse(now: number): ResponseStats {
  return {
    firstDeltaTs: now,
    maxTps: Number.NEGATIVE_INFINITY,
    minTps: Number.POSITIVE_INFINITY,
    frozen: false,
  }
}

function newState(now: number): SessionState {
  return { samples: [], response: newResponse(now) }
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
 * delta (so it cannot be missed between timer ticks) and on each tick. Warm-up
 * samples are ignored so the slow first tokens do not set an artificial floor.
 */
function recordPeakFloor(state: SessionState, now: number): void {
  if (state.response.frozen) return
  if (now - state.response.firstDeltaTs < WARMUP_MS) return
  const live = liveTps(state, "running")
  if (live <= 0) return
  if (live > state.response.maxTps) state.response.maxTps = live
  if (live < state.response.minTps) state.response.minTps = live
}

function sessionAverageTps(context: Context, sessionID: string): number {
  const messages = context.data.session.message.list(sessionID) ?? []
  let tokens = 0
  let durationMs = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const output = message.tokens?.output
    const created = message.time?.created
    const completed = message.time?.completed
    if (typeof output !== "number" || output <= 0) continue
    if (typeof created !== "number" || typeof completed !== "number" || completed <= created) continue
    tokens += output
    durationMs += completed - created
  }
  if (durationMs <= 0) return -1
  return (tokens / durationMs) * 1000
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

    const track = (sessionID: string, delta: string) => {
      if (!sessionID || typeof delta !== "string" || delta.length === 0) return
      if (context.data.session.status(sessionID) === "idle") return
      const now = Date.now()
      let state = states.get(sessionID)
      if (!state) {
        state = newState(now)
        states.set(sessionID, state)
      }
      // A frozen response belongs to the previous turn: this delta starts a new one.
      if (state.response.frozen) state.response = newResponse(now)
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

    const unsubscribers: Array<() => void> = [
      context.data.on("session.text.delta", (event) => track(event.data.sessionID, event.data.delta)),
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
          if (!sessionID) return "tok/s -"
          const state = states.get(sessionID)
          const status = context.data.session.status(sessionID)
          const live = state ? liveTps(state, status) : -1
          const average = sessionAverageTps(context, sessionID)
          const max = state?.response.maxTps ?? -1
          const min = state?.response.minTps ?? -1
          return `tok/s ${formatTps(live)}  avg ${formatTps(average)}  ↑${formatTps(max)}  ↓${formatTps(min)}`
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
