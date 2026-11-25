# Models and agents: the fork's additions

## Claude Code: Fable in the model list

- The Claude Code (CLI billing) list is upstream's own four entries: `opus`, `sonnet`, `haiku` and `fable`, all short names that the CLI resolves itself. Since the 0.7.0 merge the fork adds nothing to it: `src/agent/claude-code/provider.ts` (`CLAUDE_CODE_MODELS`) and `src/agent/claude-code/constants.ts` are upstream's again.
- **What the fork still adds:** the model menus keep the Claude Code models together at the bottom, alphabetically (`compareModels` in `components/settings/model-menu.tsx`); everything else stays alphabetical by id. Upstream sorted only by id, which put haiku, opus and sonnet at the bottom by chance and fable near the top.
- **Retired at the 0.7.0 merge:** the fork's own "Claude Fable" entry, and the mapping `claudeCliModel` that passed the full id `claude-fable-5-2` to `claude --model`. Upstream now lists `fable` itself and the CLI knows it as a short name (the Claude Code program, version 2.1.332, lists `fable` among its short names in its help). The owner chose upstream's entry ("The owner's decisions and approved words" below).
- Whether a Claude plan can use Fable through Claude Code is up to Anthropic; if not, the CLI's error shows in the lesson.
- **Not checked:** no real request was made with `--model fable`; only the program's help text was read.
- Tests that pin the list: `tests/claude-code-provider.test.ts`, `model-catalog.test.ts`, `claude-code-usage.test.tsx`, `claude-code-opt-in.test.ts` (upstream's, unedited by the fork); the order: `tests/phone-layout.test.ts`.

### The owner's decisions and approved words

- **Upstream's short name `fable`, and the fork's mapping removed** (the owner's choice at the 0.7.0 merge, "The owner's decisions at the 0.7.0 merge" in `docs/fork/upstream.md`). It replaces the owner's earlier ask for a fork entry listed as `fable` with the full id behind it (`docs/fork/history/models-and-agents.md`, "Claude Code: the fork's Fable entry").

## OpenAI and ChatGPT: GPT-6.2 in the model list

- **Why:** the owner asked for the ChatGPT models released that day. OpenAI released **GPT-6.2 Astra** and **GPT-6.2 Sol** on 17 November 2026 (API ids `gpt-6.2-astra` and `gpt-6.2-sol`, as every report gives them).
- **Why they were missing:** the ChatGPT list shows a model only when the account's own list offers it **and** the model library's `openai` catalog has the same id (`refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts`). The library, `@earendil-works/pi-ai`, was pinned at 1.4.0, whose data stopped at `gpt-6.1-sol`. Since the 0.7.0 merge it is 1.5.2 (as is `pi-agent-core`), which adds GPT-6.1 Terra and still has no GPT-6.2.
- **The owner's choice** (of three): add them in the fork now, over waiting for the library and over taking library 1.5.2 (which adds GPT-6.1 Terra only). Library 1.5.2 came with the 0.7.0 merge anyway, and the extras stay (approved with the 0.7.0 plan, `docs/fork/upstream.md`).
- **What was built:** `src/agent/extra-models.ts` (fork-owned) adds the two models to the `openai` provider (`withExtraOpenAIModels`, one marked line in `piModels()`, `src/agent/models.ts`). So they show under ChatGPT when the plan offers them, and under an OpenAI API key.
  - **Where the extras are added, since 0.7.0:** upstream now builds the ChatGPT list from the library's bundled OpenAI catalog alone (`getBuiltinModels`), which bypasses `piModels()` and with it the provider wrapper: the extras would have vanished from the ChatGPT list, and no test would have said so. `refreshConnectionCatalog` (`src/server/model-catalog.ts`, marked `FORK (GPT-6.2 models)`) now hands `refreshChatGPTModels` the bundled list plus the extras (`withExtraModels`, the one rule the provider wrapper also uses).
  - **Upstream's remote catalog** (Settings → Agent, "Refresh model catalog"; `POST /api/models`) overlays the library's catalog under an API key. The ChatGPT list never takes that overlay, as upstream intends. Under an API key the extras wrap the overlay (`piModels()`), so an overlay that lists a GPT-6.2 id gives that id once, the overlay's row.
  - **Every field except id, name and cost is copied at run time from the catalog's own `gpt-6.1-sol` entry:** a 272,000-token context window, 128,000 output tokens, the thinking levels low to max (no "off"), and the request settings. The reports give GPT-6.2 a larger window (about 1,050,000); the copied one is kept on purpose, so a long lesson is summarized earlier than it would need to be and never overflows.
  - **Cost** (an API key only; a ChatGPT plan shows no cost): Sol's is GPT-6.1 Sol's, unchanged. Astra's input and output prices (8 and 40 per million tokens) are from press reports, and its two cache prices (0.4 and 10) only keep GPT-6.1 Sol's proportions and are not confirmed.
  - An id the library already has is never added or replaced, and with no `gpt-6.1-sol` entry nothing is added.
- **To remove:** once the library knows both models and the fork takes that version, delete the file and its two uses (the line in `piModels()` and the one in `refreshConnectionCatalog`). `tests/extra-models.test.ts` fails then, with that message.
- **Where the 272k comes from** (the owner asked): the library's `openai` catalog lists 272,000 for nearly every newer model, with a price tier that starts above 272,000 input tokens; only the "pro" models are listed at 1,050,000. The ChatGPT list takes its entries from that catalog (upstream's `refreshChatGPTModels`), not from the library's separate `openai-codex` catalog, which lists GPT-6.1 Sol at 500,000. The compaction trigger is the smaller of the Settings value (150,000 by upstream's default; Settings → Agent → Context → "Compaction threshold") and the window less 16,384, so with the default the window's size changes nothing.

### Rulings, limits and open items

- **Tests since 0.7.0** (`tests/extra-models.test.ts`): the real `refreshConnectionCatalog("chatgpt")` with an overlay in place lists both GPT-6.2 ids once and no overlay-only id; an overlay row with a GPT-6.2 id appears once in `getModels`.
- **Not verified:** OpenAI's own pages couldn't be reached from the development sandbox (ids, limits and prices are from news reports and price lists); no real request and no real ChatGPT account list was tried. If ChatGPT lists the models under other ids on an account, they don't show, and nothing else changes. If OpenAI refuses a request with the copied settings, the error shows in the lesson; the owner's first use is the test.

## Research: one wrap-up request

- **A research job that ends without a brief gets one wrap-up request** (owner's report: research agents fail to produce text).
  - **The fault is upstream's**: the brief is the text of the run's **last** assistant message (`runSubagent` in `src/agent/subagents/pi-run.ts`), and a run with no text there fails with "Research failed: the researcher produced no text" (`src/agent/subagents/runner.ts`).
  - **No limit on model calls, as upstream** (since the 0.7.0 merge). Upstream removed every background helper's implicit turn cap (`maxTurns` is optional in `runSubagent`, and the researcher passes none), so a run can no longer end on a capped tool call. The fork's own 16-call limit is gone.
  - **Three ways to get there, each reproduced** with the real researcher loop and scripted model replies (no real model; a fourth, the call limit, existed until 0.7.0):
    1. **hidden text:** the last message has only thinking. Newer Claude models return text written next to a tool call as a thinking block, and the researcher has no tool to hand its brief in (the teacher and the Tutor have `send_to_user`);
    2. **the brief too early:** the brief and one more tool call in one message, then a closing message without text;
    3. **cut off:** the last message runs out of output room while thinking.
  - **Which of these the owner met isn't known**: that needs a failed job's record. (With the old limit, `usage.steps` at the limit meant the call limit.)
  - **The rule** (`wrapUp` on `runSubagent`, used by the researcher only):
    - when the run's last message has no text, the researcher is sent the wrap-up message once, and that reply's text is the brief. (A last message that is a tool call counts too, but only an explicit `maxTurns` on a caller that also passes `wrapUp` can leave one; the researcher passes neither.)
    - a tool call in that reply is refused, not run. The tools stay declared: taking them away in the middle of a run invalidates the earlier thinking blocks on newer Claude models;
    - still no text: the same failure as before;
    - not after Stop or a provider's error. The wrap-up call is counted in the job's usage like any other;
    - a run that ends with a brief makes no extra call, and nothing on screen changed.
  - **Not changed:** the PDF reader (its own loop) and every other helper.

### The owner's decisions and approved words

- **The owner's decisions** (one question each):
  - **a wrap-up request**, over that plus a hand-in tool for the brief (sturdier on Claude models, but it changes the researcher's prompt for every run) and over no fix;
  - **no limit on model calls, as upstream** (0.7.0 merge; over keeping 16 and over a higher safety limit of about 40). It replaces the earlier "the limit is 16 model calls" (`docs/fork/history/models-and-agents.md`, "Research: the 16-call limit and the first wrap-up words");
  - **the wrap-up request stays** for a run whose last message has no text (0.7.0 merge; over dropping it as upstream);
  - **the wrap-up's words** (0.7.0 merge; `RESEARCH_WRAP_UP_MESSAGE` in `src/agent/subagents/researcher.ts`): "Your last message contained no brief. Do not call any more tools. Write your final brief now, in the required format, using only what you have already gathered. If something could not be established, say so under Gaps." Chosen over dropping only the first sentence and over keeping "Your research time is up.", which no longer fits a run with no time limit. The first wording is in the history file.

### Rulings, limits and open items

- **Not checked:** a real model (whether it follows the wrap-up message, and how a real provider takes a refused tool call), and a job through the real screen.
- **Known limit:** a brief written beside one more tool call, followed by a closing message that has some text ("Done."), still delivers the closing text. A real brief can't be told from a closing remark without guessing.
- **A run with no limit can run long:** nothing but Stop ends a researcher that keeps calling tools. This is upstream's behaviour and the owner's choice over a safety limit.

### Code and tests

- **Code:** `src/agent/subagents/researcher.ts` and `pi-run.ts` (each edit marked `FORK (research wrap-up)`).
- **Tests:** `tests/researcher-wrap-up.test.ts` (the wrap-up's words; no limit: 20 tool turns then a brief, with no wrap-up; each of the three ways; a refused tool call in the wrap-up reply; abort and provider errors send none; `runSubagent` without `wrapUp` as before). `tests/background-turn-limits.test.ts` is upstream's, with one case changed for the wrap-up: a naturally empty reply now takes two requests, and the second reply is still no brief.

## ChatGPT and OpenAI: an empty reply is asked again

- **Why:** on ChatGPT models (GPT-6.2 Astra was where it was reported) a lesson sometimes stopped right after the learner answered a question. The model's reply was empty: no text and no tool call (on the owner's server, no thinking block either). The agent loop takes any reply without a tool call for the end of the run, the app saved it as a finished reply, nothing owed a continuation, and the lesson waited until the learner typed. A plain retry of the same request came back empty every time ("The plain retry, as it failed in use" in `docs/fork/history/models-and-agents.md`); a "continue" typed by the learner got the lesson going.
- **What happens now** (`src/agent/empty-reply-guard.ts`, wired into the agents' `finishTurn` and `convertToLlm` in `src/agent/teacher-agent.ts`):
  - **The empty reply is dropped and one more request is sent, with a nudge**, in the same turn. The empty reply is taken out of the next request's context, out of the loop's new messages and out of the agent's state, so it is neither sent nor saved. The new request is the same conversation with one user message added at its end: "Continue. (Your previous reply was empty; respond to the learner's last input now and do not mention this note.)" (`EMPTY_REPLY_NUDGE_TEXT`). At most 2 requests per empty turn.
  - **The nudge is in that one request only.** It is added where the conversation is converted for the model (the guard's `withNudge` wraps `toLlmMessages`), and used up there. It is never in the agent's state, the saved record, sync or the events the page receives, and no later request of the run or of a later turn carries it. Nothing new is stored: no new message type and no added message.
  - **Still empty after the nudge:** that reply is saved as a failed reply (`stopReason: "error"`, with the sentence below as its error), so the lesson shows the existing red failed-reply line and its Retry button, which work unchanged. The line reads "Something went wrong: The teacher returned an empty reply. Retry when ready.": the first three words are that line's own prefix for every failed reply. The run ends there, as it does after a provider's error. Retry starts a normal turn, without the nudge.
  - **When it applies, all of these:**
    - the conversation model's provider is `chatgpt` (the plan sign-in) or `openai` (an API key); every other provider behaves as before;
    - the agent is one of the lesson's own three (prober, teacher, practice). Not the Tutor's side questions, and not the helpers;
    - the reply ended normally (`stopReason: "stop"`; never after an error, a stop, a cut-off or a tool call) and has no tool call and no text with anything but whitespace;
    - no earlier reply of this turn had a tool call or text: a turn that ran a tool and then returned empty is not nudged;
    - the request is owed to the learner: a request the app counts as automatic (`callPurpose.background`, a wake from a finished helper) is not nudged.
  - **Usage:** the empty attempt was a real request, and its usage is counted in the turn's usage as before.
  - **On screen:** the learner sees none of it. The server still streams the dropped attempt; when the next assistant message starts, the page removes the empty one it had just streamed, so the new message takes its place (`components/session-core.ts`, `applyWireEvent`). The same holds for a reattach, which replays the same events. The page uses the guard's own definition of empty (`isGuardedEmptyReply` in `src/core/empty-reply.ts`): a ChatGPT or OpenAI reply that ended with `stop` and has no tool call and no text. It never removes another provider's message, a message already in the record, or a failed reply.
  - **The ChatGPT request cycle:** the nudged request is a new loop turn (`turn_start`), so it gets its own lease and its own dispatch, as any request does. That is why it is made in the agent loop and not inside the stream function.
- **The server log:** each time the guard looks at an empty reply owed to the learner, one line: `[LearnHarness] Empty reply: <provider>:<model>; <agent>; empty reply <1 or 2>; <nudging | giving up | not retried: follows other output in this turn>; thinking: <yes | no>; phases before: <labels>`. The labels are the phase of each text block of the assistant message before the empty reply, read from its OpenAI text signature (`commentary`, `final_answer`, or `none`). The line carries no lesson text, question, answer or id, and never the nudge. Automatic requests are not logged.

### The owner's decisions and approved words

- **The nudge** (it replaces the plain retry below): "remove the silent retries and nudge the model and make sure the user is unaware of this behavior". One request with a hidden instruction, transient, and the empty attempt hidden on the page.
- **The instruction**, word for word (`EMPTY_REPLY_NUDGE_TEXT`): "Continue. (Your previous reply was empty; respond to the learner's last input now and do not mention this note.)". "Both together" was chosen over "Continue." alone and over an explicit note alone.
- **If the nudged reply is empty too, the existing failed-reply line with Retry**, confirmed with the nudge's plan.
- **A plain retry**, over a hidden nudge (a message asking the model to go on) and over a visible line with a button. The nudge was declined then because it would store a new hidden message that syncs. **Replaced by the nudge:** in use the same request came back empty every time, and the nudge as built is never stored.
- **Up to 2 silent retries.** **Replaced by the nudge** (one nudged request, no plain retries), for the same reason.
- **If it is still empty, the existing failed-reply line with Retry**, over stopping silently and over more retries.
- **The sentence**, word for word (`EMPTY_REPLY_TEXT`): "The teacher returned an empty reply. Retry when ready."
- **ChatGPT and OpenAI models only**, over every model.
- **The request refused before it is sent** (the section below): leave it, write it down.

### Rulings, limits and open items

- **Read while building:** when the guard gives up, the run ends at once (`{ action: "end" }`), as the loop does after a provider's error, so no queued message starts another request after the failed reply and the failed reply stays the record's last message.
- **Known limits:**
  - a turn that runs a tool the learner doesn't see and then returns empty still stops. It is logged ("not retried: follows other output in this turn");
  - an answer that travels with a waiting helper result counts as automatic and is not nudged;
  - a message the learner queues while the nudged request is being prepared joins that request, before the nudge, as it would join any next request of the turn;
  - the model may still open its reply with an acknowledgement of the note, although the note asks it not to;
  - the page removes an empty ChatGPT or OpenAI reply it has just streamed whenever another assistant message follows in the same live turn, also in the rare case where the server kept it (an automatic wake's empty reply followed by a queued message's request). The record still has it, and it shows after the turn settles.
- **The cause is still not known.** The guess that the text before the question was labelled `final_answer` is discarded: the owner's server logged `phases before: commentary`, and the reply had no thinking block. Two candidates remain: the model really returns nothing for this shape of conversation (the answer arrives as a tool result after a `commentary` text), or it returns an output item the model library drops. The raw provider recorder (`LH_PROVIDER_EVENTS=1`, `src/agent/provider-events.ts`) would tell them apart; it has not been switched on.
- **Not checked:** no real ChatGPT or OpenAI model was run (only a scripted Responses backend and scripted engines). The nudge rests on the owner's experience that a typed "continue" gets the lesson going; whether the hidden one does, only the owner's use and the server log can show.

### Code and tests

- **Code:** `src/agent/empty-reply-guard.ts` (fork-owned: the instruction, the sentence, the rules, the per-run decision, the nudge's one use, the log line); `src/core/empty-reply.ts` (fork-owned: what an empty reply is, shared by the guard and the page; `isGuardedEmptyReply` exported through the core barrel); marked edits in upstream's `src/agent/teacher-agent.ts` (`baseAgentOptions`: the guard, `finishTurn`, `convertToLlm`, `FORK (empty reply)`) and `components/session-core.ts` (`applyWireEvent`, `FORK (empty reply)`).
- **Tests:** `tests/empty-reply-guard.test.ts` (the providers, what counts as empty, each stop reason, the "follows other output" rule, automatic requests, the nudge armed for one conversion and cleared by any reply, the instruction's text, the log line's content, and the guard and the page agreeing on what is empty); `tests/empty-reply-flow.test.ts` (the real `handleChatInput` through the real ChatGPT stream with a scripted backend: empty then a nudged request then a normal reply, with the nudge as the request's last input item and nowhere in the record or on the wire, and the page fed that wire showing one reply; empty twice then Retry without the nudge; a nudged reply that calls a tool, then a request without the nudge; an automatic wake; a tool call then an empty reply; usage for every request; and, with scripted engines through the same handler, an Anthropic-labelled engine not nudged and an OpenAI-labelled one nudged); `tests/empty-reply-page.test.ts` (the page: the empty attempt replaced by the next message while streaming and after, also on a reattach replay; another provider's empty reply, a failed reply, a tool-call reply, a reply with text and a message already in the record all kept).

## ChatGPT: a request refused before it is sent (known fault, not fixed)

- **What happens:** a ChatGPT request refused before it is sent, for a reason other than the background-use consent (the sign-in token can't be refreshed, or the account's model list changed in that instant), ends the turn with nothing shown and nothing saved. `finishNativeCycle` in `src/agent/subscription-request-cycle.ts` drops the error reply along with the request's other held events.
- **What follows:** read from the page's code, not run: the record then owes a continuation, and the page continues by itself (`continueIfOwed` in `components/session-core.ts`).
- **Reproduced** on the server side with a scripted backend: the wire carries only `agent_start` and `agent_end`, and the saved record ends on the answer's tool result.

### The owner's decisions and approved words

- **Leave it, write it down.** Nothing is changed.
