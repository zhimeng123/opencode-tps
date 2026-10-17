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
 *   tok/s <turn> avg <session> ↑<max> ↓<min>
 *
 * The "tok/s" segment only exists while tokens are arriving; once the session is
 * idle the meter shows just:
 *
 *   avg <session> ↑<max> ↓<min>
 *
 *   - "tok/s" is the running average for the turn in flight, on OpenCode's own
 *     terms: generated tokens (output + reasoning) over model time (request
 *     start → last token), summed across the steps of the turn. The step in
 *     flight only has estimated tokens, so the reading drifts until the turn
 *     ends — at which point it is dropped and OpenCode's exact readout, printed
 *     in the transcript, takes over.
 *   - "avg" is the mean of OpenCode's per-turn values for the session. Turns
 *     count equally, so one short reply pulls as hard as one long one.
 *   - "max" is the peak burst rate of the most recent response.
 *   - "min" is the floor burst rate of the most recent response.
 *
 * The provider API exposes no per-second token counts, so live rates are
 * inferred from streamed text. When a response completes the live window is
 * dropped; its peak/floor stay frozen so they can be read afterwards.
 */

const SAMPLE_WINDOW_MS = 5000
const LIVE_STALE_MS = 1500
const MIN_LIVE_MS = 250
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

/** The step currently streaming, used to time the live turn reading. */
type LiveStep = {
  messageID: string
  started: number
  tokens: number
  lastDeltaTs: number
}

type SessionState = {
  samples: Sample[]
  response: ResponseStats
  step: LiveStep | null
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
  return { samples: [], response: newResponse(now, ""), step: null }
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

/** Rate over the rolling sample window; feeds the peak/floor, not the readout. */
function burstTps(state: SessionState, status: "idle" | "running"): number {
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
 * Update the current response's peak/floor from the burst reading. Called on
 * every delta (so it cannot be missed between timer ticks) and on each tick. The
 * very first delta is skipped: a single chunk cannot be turned into a rate
 * without a duration, and providers can deliver an entire short response in a
 * couple of large chunks only a few hundred milliseconds apart.
 */
function recordPeakFloor(state: SessionState, now: number): void {
  if (state.response.frozen) return
  if (state.samples.length < 2) return
  if (now - state.response.firstDeltaTs < MIN_RECORD_MS) return
  const live = burstTps(state, "running")
  if (live <= 0) return
  if (live > state.response.maxTps) state.response.maxTps = live
  if (live < state.response.minTps) state.response.minTps = live
}

/**
 * OpenCode's own tokens-per-second for one turn: output + reasoning tokens over
 * the model time of its steps (`created → streamed`), so tool execution and
 * idle gaps do not count. A turn where any step never reported `streamed` has no
 * readout at all, so it comes back as -1 and is skipped everywhere.
 */
export function turnRate(turn: SessionMessageInfo[]): number {
  let tokens = 0
  let durationMs = 0
  for (const message of turn) {
    if (message.type !== "assistant") continue
    const streamed = message.time.streamed
    if (typeof streamed !== "number") return -1
    durationMs += Math.max(0, streamed - message.time.created)
    tokens += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
  }
  if (tokens <= 0 || durationMs <= 0) return -1
  return (tokens / durationMs) * 1000
}

/** Every session records an idle marker when an execution ends. */
function legacyTurns(messages: SessionMessageInfo[]): boolean {
  return !messages.some((message) => message.type === "idle")
}

/**
 * Where the turn containing `before` starts, walked the way OpenCode walks it:
 * back until an idle marker, and no further than the oldest user message of
 * that block. A legacy session has no idle marker to stop at, so it settles for
 * the nearest user message instead.
 */
function turnStart(messages: SessionMessageInfo[], before: number, legacy: boolean): number {
  let start = -1
  for (let index = before - 1; index >= 0; index--) {
    const type = messages[index].type
    if (type === "idle") return start
    if (type !== "user" && type !== "synthetic") continue
    if (legacy) return index
    start = index
  }
  return start
}

/**
 * True for the assistant message that closes a turn — the only one OpenCode
 * prints a readout for. A step that ends in a tool call keeps the turn open, so
 * a turn with tools still produces a single value covering all of its steps.
 */
function closesTurn(message: SessionMessageInfo): boolean {
  if (message.type !== "assistant") return false
  if (message.error !== undefined) return true
  const finish = message.finish
  if (finish === undefined) return false
  return finish !== "tool-calls" && finish !== "unknown"
}

/** OpenCode's readout for the turn closed by the message at `index`. */
export function turnRateAt(messages: SessionMessageInfo[], index: number, legacy = legacyTurns(messages)): number {
  const start = turnStart(messages, index + 1, legacy)
  return turnRate(messages.slice(start + 1, index + 1))
}

/** Every readout OpenCode has printed for the session, in order. */
export function turnRates(messages: SessionMessageInfo[]): number[] {
  const legacy = legacyTurns(messages)
  const rates: number[] = []
  for (let index = 0; index < messages.length; index++) {
    if (!closesTurn(messages[index])) continue
    const rate = turnRateAt(messages, index, legacy)
    if (rate > 0) rates.push(rate)
  }
  return rates
}

/**
 * Mean of the per-turn OpenCode values. Every turn counts once regardless of how
 * many tokens it produced, which is the average of the numbers OpenCode prints.
 */
export function meanTurnRate(messages: SessionMessageInfo[]): number {
  const rates = turnRates(messages)
  if (rates.length === 0) return -1
  let total = 0
  for (const rate of rates) total += rate
  return total / rates.length
}

/**
 * Tokens and model time already banked by the turn in flight: the completed
 * steps between the turn's start and the end of the transcript. A step still
 * streaming has no `streamed` timestamp yet, so it is excluded here and counted
 * from its estimates instead.
 */
export function currentTurnTotals(messages: SessionMessageInfo[]): { tokens: number; ms: number } {
  const start = turnStart(messages, messages.length, legacyTurns(messages))
  let tokens = 0
  let ms = 0
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    const streamed = message.time.streamed
    if (typeof streamed !== "number") continue
    ms += Math.max(0, streamed - message.time.created)
    tokens += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
  }
  return { tokens, ms }
}

/**
 * Live reading for the turn in flight, on OpenCode's terms: generated tokens
 * over model time, accumulated across the steps of the turn. Completed steps
 * contribute their real numbers, the step in flight contributes estimated
 * tokens measured up to its most recent delta — which also stops the clock
 * during tool calls. The reading is dropped the moment tokens stop arriving, so
 * a stale number is never left on screen.
 */
function liveTurnTps(state: SessionState, messages: SessionMessageInfo[], status: "idle" | "running"): number {
  if (status === "idle") return -1
  const step = state.step
  if (!step || step.tokens <= 0) return -1
  const now = Date.now()
  if (now - step.lastDeltaTs > LIVE_STALE_MS) return -1
  const elapsed = step.lastDeltaTs - step.started
  if (elapsed < MIN_LIVE_MS) return -1
  const banked = currentTurnTotals(messages)
  const durationMs = banked.ms + elapsed
  const tokens = banked.tokens + step.tokens
  if (durationMs <= 0 || tokens <= 0) return -1
  return (tokens / durationMs) * 1000
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

function latestResponseTps(messages: SessionMessageInfo[]): number {
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

    const stateFor = (sessionID: string, now: number): SessionState => {
      let state = states.get(sessionID)
      if (!state) {
        state = newState(now)
        states.set(sessionID, state)
      }
      return state
    }

    const track = (sessionID: string, messageID: string, delta: string, reasoning: boolean) => {
      if (!sessionID || typeof delta !== "string" || delta.length === 0) return
      const now = Date.now()
      const state = stateFor(sessionID, now)
      const tokens = estimateTokens(delta)
      // Peak/floor follow streamed *text* only — they describe visible output.
      if (!reasoning) {
        // Each assistant message is its own response. A session can flap to idle
        // between text blocks, so key the response on the message id instead of on
        // idle — otherwise the peak/floor get wiped by the final short block.
        if (state.response.messageID !== messageID) {
          state.response = newResponse(now, messageID)
          state.samples = []
        }
        state.samples.push({ tokens, ts: now })
        recordPeakFloor(state, now)
      }
      // The live reading mirrors OpenCode's numerator, which is output + reasoning.
      if (!state.step || state.step.messageID !== messageID) {
        state.step = { messageID, started: now, tokens: 0, lastDeltaTs: now }
      }
      state.step.tokens += tokens
      state.step.lastDeltaTs = now
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
    const dedupe = (event: unknown): boolean => {
      const id = (event as { id?: string }).id
      if (!id) return false
      if (seenEvents.has(id)) return true
      seenEvents.add(id)
      if (seenEvents.size > 8192) seenEvents.clear()
      return false
    }

    const unsubscribers: Array<() => void> = [
      context.data.on("session.text.delta", (event) => {
        if (dedupe(event)) return
        track(event.data.sessionID, event.data.assistantMessageID, event.data.delta, false)
      }),
      context.data.on("session.reasoning.delta", (event) => {
        if (dedupe(event)) return
        track(event.data.sessionID, event.data.assistantMessageID, event.data.delta, true)
      }),
      context.data.on("session.step.started", (event) => {
        const now = Date.now()
        const state = stateFor(event.data.sessionID, now)
        state.step = {
          messageID: event.data.assistantMessageID,
          started: typeof event.data.started === "number" ? event.data.started : now,
          tokens: 0,
          lastDeltaTs: 0,
        }
        bump()
      }),
      context.data.on("session.step.ended", (event) => {
        const state = states.get(event.data.sessionID)
        if (!state?.step || state.step.messageID !== event.data.assistantMessageID) return
        state.step = null
        bump()
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
          const messages = context.data.session.message.list(sessionID) ?? []
          const live = state ? liveTurnTps(state, messages, status) : -1
          const average = meanTurnRate(messages)
          let max = state?.response.maxTps ?? -1
          let min = state?.response.minTps ?? -1
          // A response can be too short to sample a peak/floor. Once it is idle,
          // fall back to its real average so the slots are not left empty.
          if ((!Number.isFinite(max) || !Number.isFinite(min)) && status === "idle") {
            const fallback = latestResponseTps(messages)
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
