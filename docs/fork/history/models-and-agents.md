# History and records: Models and agents: the fork's additions

## Claude Code: Fable in the model list

### Claude Code: the fork's Fable entry (retired at the 0.7.0 merge)

- **What it was:** a fork entry in the Claude Code list, **Claude Fable**, listed as `fable` to match upstream's three aliases (`opus`, `sonnet`, `haiku`; the owner's ask). The CLI had no such alias then, so `claudeCliModel` (`src/agent/claude-code/constants.ts`, with `CLAUDE_CODE_CLI_MODEL = { fable: "claude-fable-5-2" }`) passed the full id `claude-fable-5-2` to `claude --model`.
- **What retired it:** upstream 0.7.0 lists `fable` itself, as a short name the CLI resolves. At the merge the owner chose upstream's entry over the fork's mapping; `constants.ts` and the list in `provider.ts` are upstream's again (`docs/fork/upstream.md`, "The owner's decisions at the 0.7.0 merge", decision 7).
- **What was run at the merge:** the Claude Code program's help (version 2.1.332) was read and lists `fable` as a short name. No real request was made. The tests that pin the list pass with upstream's entry.

## Research: one wrap-up request

### The research wrap-up, what was checked

- **Written for the 16-call limit** (retired at the 0.7.0 merge, which removed the limit; the other ways and the checks of them stand): the first of the four ways was the call limit, and the checks below that mention it ("16 tool calls make exactly 17 model calls") belong to the limit. Since the merge `tests/researcher-wrap-up.test.ts` runs 20 tool turns then a brief with no wrap-up.
- **Checked** with scripted model replies only, by the implementer and then by an independent verifier with a script of its own: each of the four ways and the quiet variant now ends in the wrap-up's brief; 16 tool calls make exactly 17 model calls; a tool call in the wrap-up reply never ran; a wrap-up reply without text gives the old failure and no second wrap-up; a run that ends with a brief makes no extra call; a caller without `wrapUp` is as before. Typecheck clean, lint with its one existing warning.

### Research: the 16-call limit and the first wrap-up words

- **The limit:** the researcher's loop was capped at 16 model calls (upstream's was 12; the owner chose 16; the others offered were 12 and 20), so a job made at most 17 calls with the wrap-up. The limit was the first of four ways to end without a brief (`maxTurns` 16 in `src/agent/subagents/researcher.ts`).
- **The first wrap-up words** (the owner's choice over a shorter text without the last sentence): "Your research time is up. Do not call any more tools. Write your final brief now, in the required format, using only what you have already gathered. If something could not be established, say so under Gaps."
- **Retired at the 0.7.0 merge:** upstream removed the implicit turn cap of every background helper, and the owner chose no limit (`docs/fork/models-and-agents.md`, "Research: one wrap-up request"). The words changed because "research time is up" no longer describes the run: "Your last message contained no brief. …".

## ChatGPT and OpenAI: an empty reply is asked again

### The reproduction, before the change

- **How it was run:** the real `handleChatInput` through the real ChatGPT stream (`chatGPTStream`), with the desktop's ChatGPT bridge played by a faked IPC and the Responses API by a scripted `globalThis.fetch` (modelled on `tests/chatgpt-request-cycle.test.ts`). Each case answers a waiting quiz question in a teaching session. No real model.
- **The five cases and what was seen:**
  1. **Normal** (reasoning, then a final-answer message): one request; the reply is saved and the lesson goes on.
  2. **Lease refused** before the request was sent (as when the sign-in token can't be refreshed): no request; the wire carries only `agent_start` and `agent_end`; nothing is saved after the answer's tool result; the record owes a continuation.
  3. **Authority changed** between the scope's capture and the dispatch (the account's model list changed): the same as case 2.
  4. **Reasoning only** (no message item): one request; the reply is saved as a finished reply with only a thinking block (`stopReason: "stop"`); the record owes nothing, so the lesson waits for the learner. This is the reported pause.
  5. **Commentary only** (one message item in the `commentary` phase): one request; the reply is saved with its thinking and text, and shown. Not a pause.
- Cases 2 and 3 are the known fault recorded in `models-and-agents.md` ("ChatGPT: a request refused before it is sent"), left as it is at the owner's word.

### After the change, what was run

- **Case 4 again:** three requests, three leases, three log lines (retrying, retrying, giving up); the saved record ends on one failed reply with "The teacher returned an empty reply. Retry when ready."
- **`tests/empty-reply-flow.test.ts`** (5 tests, all pass; 4 of them fail with the `teacher-agent.ts` edit taken out, the automatic wake passes either way, as it should):
  - empty, then a normal reply: 2 requests with their own leases; the second request is the first one again (same input items, without the dropped reasoning); the saved record is the answer's result and the normal reply only; the retry's events reach the wire (two `turn_start`); usage for both requests;
  - three empties: 3 requests; the record ends on the failed reply (the third reply's thinking); `retryDrops` accepts it; a `retry` input then runs a normal turn;
  - an automatic wake (`steers`) whose reply is empty: 1 request, saved as before, no error, no log line;
  - a tool call, then an empty reply: not retried, saved as before, logged as "not retried: follows other output in this turn";
  - scripted engines through the same handler: an Anthropic-labelled engine is not retried; an OpenAI-labelled one is.
- **`tests/empty-reply-guard.test.ts`**: 24 tests, all pass.
- **The other runs** (Node 22, the development sandbox): `tests/chatgpt-request-cycle.test.ts` 18 of 18, `tests/chatgpt-stream.test.ts` 11 of 11, `tests/chat-flow.test.ts` 41 of 41, `tests/narration-guard.test.ts` 28 of 28. The whole suite without `tests/safe-fetch.test.ts` (it hangs here) and without `tests/gateway-review.test.ts`: 7,030 tests, 7,022 pass, 4 fail, 4 skipped; the 4 failures are the known sandbox ones (`passive-tooltip`, `safe-fetch-connector`, one case each of `plugin-document-proxy` and `subscription-auth`). `tests/gateway-review.test.ts` hung here in "review 2: a shutdown waits for a redeem under way", run alone too; it imports nothing this change touched. Typecheck clean; lint with its one existing warning.
- **The independent check:** 20 test files run one at a time, all passing, among them every other file that builds the teacher with a ChatGPT or OpenAI model except `tests/demos.test.tsx`, which was not run. With `finishTurn` made to return nothing in a scratch copy, 4 of the 5 flow tests fail and the automatic wake passes. No defect found in the guard or the edit. Not tested: a message the learner queued when the guard gives up.
- **`tests/gateway-review.test.ts` hung without this change too** (run alone with a 600-second limit, on the commit before it, `fa5dda0`, and on this one). It was not the sandbox: the server image workflow hung in the same file when this round shipped. The cause and the repair are in `docs/fork/development.md` (a gateway test's clock).
- **The browser run** (Chromium against `next dev` in server mode, the golden teaching chat cut after a `quiz` call, the session on `openai:gpt-5` with a dummy key, and a preload that answers `api.openai.com/v1/responses` with scripted replies and refuses every other host):
  - **empty, then a reply:** 2 requests. The lesson went on with no typing and no error line. The thinking blocks on screen went from 4 to 5 to 6 during the turn and back to 5 once it settled, and stayed 5 after a reload: the dropped thought is gone. The saved record ends on the answer's result and one reply. The same at iPhone 13 size;
  - **three empties:** 3 requests, then the red line: "Something went wrong: The teacher returned an empty reply. Retry when ready." with Retry ("Something went wrong:" is the line's own prefix for every failed reply). It was still there after a reload. With the script switched to a normal reply, Retry made 1 request and the lesson went on. The same at iPhone 13 size;
  - **a normal reply:** 1 request, nothing different, no log line.
  - The log lines read as built, for example `[LearnHarness] Empty reply: openai:gpt-5; teacher; empty reply 1; retrying; thinking: yes; phases before: none`, with no lesson text in them.
  - Seen: while the retry starts, the open thinking block shows an empty body for a moment before the second thought arrives.
  - Not run: a real OpenAI reply, and the ChatGPT sign-in path in a browser (the flow tests cover that path on the server side).

### The plain retry, as it failed in use

- **Shipped** as releases 0.6.51 (the guard, `a14973f`) and 0.6.52 (the test repair, the same app), and on the server image `:dev` from the same commit.
- **On the owner's server, with GPT-6.2 Astra,** the same request came back empty every time: two turns, three requests each, six empty replies, then the red line in both turns. The log lines read:
  - `[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; empty reply 1; retrying; thinking: no; phases before: commentary`
  - then `empty reply 2; retrying` and `empty reply 3; giving up`, with the same other fields.
- **What they showed:**
  - the reply was completely empty, with no thinking block either (`thinking: no`);
  - the text before the question was labelled `commentary`, so the earlier guess (`final_answer`) was wrong;
  - an identical request gets the identical empty answer, so a plain retry cannot help.
- **What did work,** by the owner's experience: a real user message ("continue") typed after the empty turn. The learner's answer reaches the model as the question tool's result, not as a user message. That led to the nudge (`models-and-agents.md`, "ChatGPT and OpenAI: an empty reply is asked again").

### The nudge, what was run

- **No real model.** Node 22, the development sandbox.
- **`tests/empty-reply-flow.test.ts`** (6 tests, all pass), the real `handleChatInput` through the real ChatGPT stream with a scripted Responses backend:
  - empty, then a normal reply: 2 requests with their own leases; the second request's last input item is a user message whose text is exactly the instruction, and it has one input item more than the first and none of the dropped reply; the saved record is the answer's result and the normal reply only; the saved file and every wire event are free of the instruction; a page model fed that wire never shows more than one assistant message; usage for both requests;
  - empty twice: 2 requests; the record ends on the failed reply (the nudged reply's thinking); `retryDrops` accepts it; a `retry` input runs a normal turn whose one request has no nudge;
  - a nudged reply that calls a tool: 3 requests; the third, after the tool result, has no nudge;
  - an automatic wake (`steers`) whose reply is empty: 1 request, no nudge; a tool call then an empty reply: not nudged; an Anthropic-labelled scripted engine: not nudged; an OpenAI-labelled one: nudged, the nudge being the last message the engine saw.
- **`tests/empty-reply-guard.test.ts`**: 28 tests, all pass (the nudge armed for one conversion, used up there and cleared by any reply; the instruction word for word; the log words; the guard and the page agreeing on what is empty).
- **`tests/empty-reply-page.test.ts`**: 9 tests, all pass; 4 of them fail with the page's rule switched off in a scratch copy (the ones that expect the empty attempt hidden), the 5 that expect a message kept pass either way.
- **The flow tests need the conversion's wrap:** with `convertToLlm` put back to plain `toLlmMessages` in a scratch copy, 4 of the 6 fail (the three nudged cases and the scripted OpenAI engine); the automatic wake and the tool call before an empty reply pass either way, as they should.
- **The other runs:** `tests/chatgpt-request-cycle.test.ts` 18 of 18, `tests/chatgpt-stream.test.ts` 11 of 11, `tests/chat-flow.test.ts` 41 of 41, `tests/narration-guard.test.ts` 28 of 28, `tests/session-core.test.ts` 102 of 102, and every other test file that drives `components/session-core.ts` (24 files, among them `retry-failed-turn`, `send-to-user`, `session-stamp`, `session-move` and the plugin question and problem front-end tests), all passing. The whole suite without `tests/safe-fetch.test.ts` (it hangs here) and the seven `tests/plugin-*types.test.ts` files: 7,052 tests, 7,044 pass, 4 fail, 4 skipped; the 4 failures are the known sandbox ones (`passive-tooltip`, `safe-fetch-connector`, one case each of `plugin-document-proxy` and `subscription-auth`). The seven type test files, one at a time: all pass. Typecheck clean; lint with its one existing warning.
- **Not run:** a browser run, a real model.
- **The nudge's independent check:** 15 test files run one at a time, all passing (the guard 28, the flow 6, the page 9, `session-core` 102, and the request cycle, stream, chat flow, retry and gateway files). In a scratch copy, with the `convertToLlm` wrap made to do nothing 4 of the 6 flow tests fail, and with the page rule removed 4 of the 9 page tests fail. No defect found. Reasoned from the code, not run: a nudged request refused before it is sent is asked again without the nudge; an automatic wake's empty reply that the page hid comes back when the turn settles.
- **The nudge's browser run** (Chromium against `next dev` in server mode, the same stand-in for `api.openai.com`, now also recording each request body, with two shapes of an empty reply: a completed response with no output items, as the owner's server logged, and a reasoning-only one; the page sampled every 100 ms from the click until the turn settled):
  - **empty, then a reply** (both shapes; a computer and iPhone 13 size): 2 requests. The second is the first plus one item, a last user message with the instruction, word for word, and holds nothing of the empty attempt. The lesson went on with no typing and no error line. At no sample did the page show more thought blocks, assistant groups or dividers than the control (5, 11 and 18 on a computer; 3, 11 and 18 at iPhone size). The instruction was never in the page's text or HTML, nor in the saved chat file, before or after a reload;
  - **empty twice:** 2 requests, only the second with the instruction, then the red line ("Something went wrong: The teacher returned an empty reply. Retry when ready.") with Retry; it survived a reload. Retry with a normal reply: 1 request without the instruction, and the lesson went on;
  - **a normal reply:** 1 request, no instruction;
  - **a nudged reply that calls a tool:** 3 requests; the second carries the instruction, the third does not;
  - the log lines read `…; empty reply 1; nudging; thinking: no; …` and `…; empty reply 2; giving up; …`, with no lesson text.
  - Not run: a real model; the two-empties run at iPhone size; the Windows app.

