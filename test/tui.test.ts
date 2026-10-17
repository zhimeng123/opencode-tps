import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { currentTurnTotals, meanTurnRate, turnRates } from "../src/tui"

type AssistantOpts = {
  output?: number
  reasoning?: number
  created?: number
  streamed?: number
  completed?: number
  finish?: "stop" | "length" | "tool-calls" | "unknown"
}

const assistant = (opts: AssistantOpts): SessionMessageInfo =>
  ({
    type: "assistant",
    id: "a",
    time: { created: opts.created ?? 0, streamed: opts.streamed, completed: opts.completed },
    tokens: {
      input: 0,
      output: opts.output ?? 0,
      reasoning: opts.reasoning ?? 0,
      cache: { read: 0, write: 0 },
    },
    finish: opts.finish ?? "stop",
    content: [],
  }) as unknown as SessionMessageInfo

const user = (): SessionMessageInfo =>
  ({ type: "user", id: "u", time: { created: 0 }, text: "hi" }) as unknown as SessionMessageInfo

const idle = (): SessionMessageInfo =>
  ({ type: "idle", id: "i", time: { created: 0 }, outcome: "succeeded" }) as unknown as SessionMessageInfo

describe("turnRates", () => {
  test("rates a session that has no idle marker one reply at a time", () => {
    const messages = [
      user(),
      assistant({ output: 1000, streamed: 10000 }), // 100 tok/s
      user(),
      assistant({ output: 2, streamed: 2000 }), // 1 tok/s
    ]
    expect(turnRates(messages)).toEqual([100, 1])
  })

  test("bounds each turn by the idle marker that ends an execution", () => {
    const messages = [
      user(),
      assistant({ output: 1000, streamed: 10000 }),
      idle(),
      user(),
      assistant({ output: 2, streamed: 2000 }),
      idle(),
    ]
    expect(turnRates(messages)).toEqual([100, 1])
  })

  test("counts output + reasoning and sums every step of a turn", () => {
    const messages = [
      user(),
      assistant({ output: 300, reasoning: 100, streamed: 2000, finish: "tool-calls" }),
      assistant({ output: 400, streamed: 2000 }),
      idle(),
    ]
    // (300 + 100 + 400) tokens over 4s
    expect(turnRates(messages)).toEqual([200])
  })

  test("skips a turn whose messages never reported streamed", () => {
    const messages = [user(), assistant({ output: 100, completed: 5000 }), idle()]
    expect(turnRates(messages)).toEqual([])
  })
})

describe("meanTurnRate", () => {
  test("averages the per-turn values without weighting by size", () => {
    const messages = [
      user(),
      assistant({ output: 1000, streamed: 10000 }), // 100 tok/s
      idle(),
      user(),
      assistant({ output: 2, streamed: 2000 }), // 1 tok/s
      idle(),
    ]
    // A weighted average would give 1002/12 = 83.5; the mean of the values is 50.5.
    expect(meanTurnRate(messages)).toBeCloseTo(50.5, 5)
  })

  test("is -1 when no turn has a value", () => {
    expect(meanTurnRate([user()])).toBe(-1)
  })
})

describe("currentTurnTotals", () => {
  test("banks only completed steps of the running turn", () => {
    const messages = [
      user(),
      assistant({ output: 100, streamed: 1000 }),
      idle(),
      user(),
      assistant({ output: 10, reasoning: 5, streamed: 500 }), // banked
      assistant({ output: 999, finish: undefined as never }), // in flight, no streamed yet
    ]
    expect(currentTurnTotals(messages)).toEqual({ tokens: 15, ms: 500 })
  })

  test("counts from the start of the session when there is no turn boundary", () => {
    expect(currentTurnTotals([assistant({ output: 50, streamed: 1000 })])).toEqual({
      tokens: 50,
      ms: 1000,
    })
  })
})
