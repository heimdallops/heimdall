// SDK: @anthropic-ai/claude-agent-sdk
//
// Streaming is enabled via `options.includePartialMessages: true` in the
// `query()` call. When enabled, `SDKPartialAssistantMessage` events (type:
// 'stream_event') are emitted through the async generator before the full
// `SDKAssistantMessage` arrives.
//
// Each `SDKPartialAssistantMessage` carries a `BetaRawMessageStreamEvent` in
// its `event` field. Text deltas come as `BetaRawContentBlockDeltaEvent`
// (type: 'content_block_delta') with a delta of type `BetaTextDelta`
// (type: 'text_delta', text: string).
//
// The session ID appears on every message as the `session_id` string field.
// The first message yielded by the generator is the first opportunity to
// capture it.
//
// Cancellation is passed via `options.abortController: AbortController`. The
// `AbortController` is set in `Options.abortController`. When aborted, the
// generator throws or terminates early.
//
// The SDK exports a single `query` function (not a class):
//   query({ prompt: string, options?: Options }): Query
// where `Query extends AsyncGenerator<SDKMessage, void>`.
// There is no client constructor — `query` is called directly as a module-level
// function. Credentials are read from the environment (ANTHROPIC_API_KEY) or
// the existing Claude Code installation; no explicit credential passing is
// required or supported in the SDK public API.

export {};
