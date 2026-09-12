import assert from "node:assert/strict"
import test from "node:test"

import {
  extractFinalText,
} from "../../bridge/final-text.mjs"

const context = {
  agent: "opencode-orchestrator-scout",
  sessionID: "ses_test",
}

test("extractFinalText joins and trims assistant text parts", () => {
  const result = extractFinalText(
    {
      finish: "stop",
      content: [
        { type: "reasoning", text: "ignored" },
        { type: "text", text: " first " },
        { type: "text", text: "second\n" },
      ],
    },
    context,
  )

  assert.equal(result, "first \nsecond")
})

test("extractFinalText supports nested message info and parts", () => {
  const result = extractFinalText(
    {
      info: { finish: "stop" },
      parts: [{ type: "text", text: "legacy shape" }],
    },
    context,
  )

  assert.equal(result, "legacy shape")
})

test("extractFinalText propagates provider errors", () => {
  assert.throws(
    () => extractFinalText(
      {
        finish: "error",
        content: [],
        error: {
          type: "provider.invalid-request",
          message: 'only "auto" is supported for tool_choice',
          status: 400,
        },
      },
      context,
    ),
    /session ses_test failed: only "auto" is supported for tool_choice/,
  )
})

test("extractFinalText rejects a populated nested error even without an error finish", () => {
  assert.throws(
    () => extractFinalText(
      {
        info: {
          finish: "stop",
          error: { message: "session failed" },
        },
        parts: [{ type: "text", text: "stale text" }],
      },
      context,
    ),
    /session ses_test failed: session failed/,
  )
})

test("extractFinalText preserves the genuine empty-text fallback", () => {
  assert.throws(
    () => extractFinalText(
      {
        finish: "stop",
        content: [{ type: "reasoning", text: "not a final answer" }],
      },
      context,
    ),
    /session ses_test produced no final text/,
  )
})

test("extractFinalText reports a missing assistant result", () => {
  assert.throws(
    () => extractFinalText(undefined, context),
    /session ses_test produced no assistant result/,
  )
})
