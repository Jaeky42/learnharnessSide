# Models and agents: the fork's additions

## Claude Code: Fable in the model list

- The Claude Code (CLI billing) list is upstream's three aliases (`opus`, `sonnet`, `haiku`, which the CLI resolves to the newest of each) plus a fork entry, **Claude Fable**, listed as `fable` to match them (owner's ask). The CLI has no such alias, so `claudeCliModel` (`src/agent/claude-code/constants.ts`) passes the full id `claude-fable-5-2` to `claude --model`.
- The model menus keep the Claude Code models together at the bottom, alphabetically (`compareModels` in `components/settings/model-menu.tsx`); everything else stays alphabetical by id. Upstream sorted only by id, which put haiku, opus and sonnet at the bottom by chance and fable near the top.
- Whether a Claude plan can use Fable through Claude Code is up to Anthropic; if not, the CLI's error shows in the lesson.
- Code: `src/agent/claude-code/provider.ts` (`CLAUDE_CODE_MODELS`). Tests that pin the list: `tests/claude-code-provider.test.ts`, `model-catalog.test.ts`, `claude-code-usage.test.tsx`, `claude-code-opt-in.test.ts`; the order: `tests/phone-layout.test.ts`.

## OpenAI and ChatGPT: GPT-6.2 in the model list

- **Why:** the owner asked for the ChatGPT models released that day. OpenAI released **GPT-6.2 Astra** and **GPT-6.2 Sol** on 17 November 2026 (API ids `gpt-6.2-astra` and `gpt-6.2-sol`, as every report gives them).
- **Why they were missing:** the ChatGPT list shows a model only when the account's own list offers it **and** the model library's `openai` catalog has the same id (`refreshChatGPTModels` in `src/agent/chatgpt-bridge.ts`). The library, `@earendil-works/pi-ai`, is pinned at 1.4.0, whose data stops at `gpt-6.1-sol`; its newest release then (1.5.2, 10 November) stops at `gpt-6.1-terra`.
- **The owner's choice** (of three): add them in the fork now, over waiting for the library and over taking library 1.5.2 (which adds GPT-6.1 Terra only).
- **What was built:** `src/agent/extra-models.ts` (fork-owned) adds the two models to the `openai` provider before it is registered (`withExtraOpenAIModels`, one marked line in `piModels()`, `src/agent/models.ts`). So they show under ChatGPT when the plan offers them, and under an OpenAI API key.
  - **Every field except id, name and cost is copied at run time from the catalog's own `gpt-6.1-sol` entry:** a 272,000-token context window, 128,000 output tokens, the thinking levels low to max (no "off"), and the request settings. The reports give GPT-6.2 a larger window (about 1,050,000); the copied one is kept on purpose, so a long lesson is summarized earlier than it would need to be and never overflows.
  - **Cost** (an API key only; a ChatGPT plan shows no cost): Sol's is GPT-6.1 Sol's, unchanged. Astra's input and output prices (8 and 40 per million tokens) are from press reports, and its two cache prices (0.4 and 10) only keep GPT-6.1 Sol's proportions and are not confirmed.
  - An id the library already has is never added or replaced, and with no `gpt-6.1-sol` entry nothing is added.
- **To remove:** once the library knows both models and the fork takes that version, delete the file and the line. `tests/extra-models.test.ts` fails then, with that message.
- **Where the 272k comes from** (the owner asked): the library's `openai` catalog lists 272,000 for nearly every newer model, with a price tier that starts above 272,000 input tokens; only the "pro" models are listed at 1,050,000. The ChatGPT list takes its entries from that catalog (upstream's `refreshChatGPTModels`), not from the library's separate `openai-codex` catalog, which lists GPT-6.1 Sol at 500,000. The compaction trigger is the smaller of the Settings value (150,000 by upstream's default; Settings → Agent → Context → "Compaction threshold") and the window less 16,384, so with the default the window's size changes nothing.

### Rulings, limits and open items

- **Not verified:** OpenAI's own pages couldn't be reached from the development sandbox (ids, limits and prices are from news reports and price lists); no real request and no real ChatGPT account list was tried. If ChatGPT lists the models under other ids on an account, they don't show, and nothing else changes. If OpenAI refuses a request with the copied settings, the error shows in the lesson; the owner's first use is the test.

## Research: one wrap-up request

- **A research job that ends without a brief gets one wrap-up request** (owner's report: research agents fail to produce text).
  - **The fault is upstream's**, unchanged in 0.6.1: the brief is the text of the run's **last** assistant message (`runSubagent` in `src/agent/subagents/pi-run.ts`), and a run with no text there fails with "Research failed: the researcher produced no text" (`src/agent/subagents/runner.ts`).
  - **Four ways to get there, each reproduced** with the real researcher loop and scripted model replies (no real model):
    1. **the call limit:** the run ends right after the model call that reaches the limit, also when that call was one more search, so the brief is never asked for;
    2. **hidden text:** the last message has only thinking. Newer Claude models return text written next to a tool call as a thinking block, and the researcher has no tool to hand its brief in (the teacher and the Tutor have `send_to_user`);
    3. **the brief too early:** the brief and one more tool call in one message, then a closing message without text;
    4. **cut off:** the last message runs out of output room while thinking.
    - A quiet variant of the first: a line such as "Let me check one more source." beside the last tool call was delivered as the brief, with no failure shown.
  - **Which of these the owner met isn't known**: that needs a failed job's record (`usage.steps` at the limit means the first).
  - **The rule** (`wrapUp` on `runSubagent`, used by the researcher only):
    - when the run's last message made a tool call, or has no text, the researcher is sent the wrap-up message once, and that reply's text is the brief;
    - a tool call in that reply is refused, not run. The tools stay declared: taking them away in the middle of a run invalidates the earlier thinking blocks on newer Claude models;
    - still no text: the same failure as before;
    - not after Stop or a provider's error. The wrap-up call is counted in the job's usage like any other;
    - a run that ends with a brief makes no extra call, and nothing on screen changed.
  - **Not changed:** the PDF reader (its own loop and limit) and every other helper.

### The owner's decisions and approved words

- **The owner's decisions** (one question each):
  - **a wrap-up request**, over that plus a hand-in tool for the brief (sturdier on Claude models, but it changes the researcher's prompt for every run) and over no fix;
  - **the limit is 16 model calls** (it was 12; the others offered were 12 and 20). With the wrap-up a job makes at most 17;
  - **the wrap-up's words:** "Your research time is up. Do not call any more tools. Write your final brief now, in the required format, using only what you have already gathered. If something could not be established, say so under Gaps." (`RESEARCH_WRAP_UP_MESSAGE` in `src/agent/subagents/researcher.ts`; over a shorter text without the last sentence).

### Rulings, limits and open items

- **Not checked:** a real model (whether it follows the wrap-up message, and how a real provider takes a refused tool call), and a job through the real screen.
- **Known limit:** a brief written beside one more tool call, followed by a closing message that has some text ("Done."), still delivers the closing text. A real brief can't be told from a closing remark without guessing.

### Code and tests

- **Tests:** `tests/researcher-wrap-up.test.ts`.

## ChatGPT and OpenAI: an empty reply is asked again

- **Why:** on ChatGPT models (GPT-6.2 Astra was where it was reported) a lesson sometimes stopped right after the learner answered a question. The model's reply had only thinking: no text and no tool call. The agent loop takes any reply without a tool call for the end of the run, the app saved it as a finished reply, nothing owed a continuation, and the lesson waited until the learner typed.
- **What happens now** (`src/agent/empty-reply-guard.ts`, wired into the agents' `finishTurn` in `src/agent/teacher-agent.ts`):
  - **The empty reply is dropped and the same request is sent again**, in the same turn, up to **2** times (at most 3 requests). It is taken out of the next request's context, out of the loop's new messages and out of the agent's state, so it is neither sent nor saved. Nothing new is stored: no new message type and no added message.
  - **Still empty after the 2 retries:** that last reply is saved as a failed reply (`stopReason: "error"`, with the sentence below as its error), so the lesson shows the existing red failed-reply line and its Retry button, which work unchanged. The line reads "Something went wrong: The teacher returned an empty reply. Retry when ready.": the first three words are that line's own prefix for every failed reply. The run ends there, as it does after a provider's error.
  - **When it applies, all of these:**
    - the conversation model's provider is `chatgpt` (the plan sign-in) or `openai` (an API key); every other provider behaves as before;
    - the agent is one of the lesson's own three (prober, teacher, practice). Not the Tutor's side questions, and not the helpers;
    - the reply ended normally (`stopReason: "stop"`; never after an error, a stop, a cut-off or a tool call) and has no tool call and no text with anything but whitespace;
    - no earlier reply of this turn had a tool call or text: a turn that ran a tool and then returned empty is not retried;
    - the request is owed to the learner: a request the app counts as automatic (`callPurpose.background`, a wake from a finished helper) is not retried.
  - **Usage:** the empty attempts were real requests, and their usage is counted in the turn's usage as before.
  - **On screen during a retry:** the first thinking folds and a second one starts. The dropped thought is gone once the turn settles.
  - **The ChatGPT request cycle:** each retry is a new loop turn (`turn_start`), so it gets its own lease and its own dispatch, as any request does. That is why the retry is made in the agent loop and not inside the stream function.
- **The server log:** each time the guard looks at an empty reply owed to the learner, one line: `[LearnHarness] Empty reply: <provider>:<model>; <agent>; empty reply <1, 2 or 3>; <retrying | giving up | not retried: follows other output in this turn>; thinking: <yes | no>; phases before: <labels>`. The labels are the phase of each text block of the assistant message before the empty reply, read from its OpenAI text signature (`commentary`, `final_answer`, or `none`). The line carries no lesson text, question, answer or id. Automatic requests are not logged.

### The owner's decisions and approved words

- **A plain retry**, over a hidden nudge (a message asking the model to go on) and over a visible line with a button. The nudge was declined because it would store a new hidden message that syncs.
- **Up to 2 silent retries.**
- **If it is still empty, the existing failed-reply line with Retry**, over stopping silently and over more retries.
- **The sentence**, word for word (`EMPTY_REPLY_TEXT`): "The teacher returned an empty reply. Retry when ready."
- **ChatGPT and OpenAI models only**, over every model.
- **The request refused before it is sent** (the section below): leave it, write it down.

### Rulings, limits and open items

- **Read while building:** when the guard gives up, the run ends at once (`{ action: "end" }`), as the loop does after a provider's error, so no queued message starts another request after the failed reply and the failed reply stays the record's last message.
- **Known limits:**
  - a turn that runs a tool the learner doesn't see and then returns empty still stops. It is logged ("not retried: follows other output in this turn");
  - an answer that travels with a waiting helper result counts as automatic and is not retried;
  - a message the learner queues while a retry is being prepared joins that retry's request, as it would join any next request of the turn.
- **Not checked:** no real ChatGPT or OpenAI model was run (only a scripted Responses backend and scripted engines). The cause of the empty reply is not known. A guess only: the answer reaches the model as a tool result after text the model had labelled its final answer; the log line's phase labels are there to check that. How often a plain retry is enough only the owner's use and the log can show.

### Code and tests

- **Code:** `src/agent/empty-reply-guard.ts` (fork-owned: the limit, the sentence, the rules, the per-run decision, the log line); one marked edit in upstream's `src/agent/teacher-agent.ts` (`baseAgentOptions`, `FORK (empty reply)`).
- **Tests:** `tests/empty-reply-guard.test.ts` (the providers, what counts as empty, each stop reason, the "follows other output" rule, automatic requests, the limit, the log line's content); `tests/empty-reply-flow.test.ts` (the real `handleChatInput` through the real ChatGPT stream with a scripted backend: empty then a normal reply, three empties then Retry, an automatic wake, a tool call then an empty reply, usage for every request; and, with scripted engines through the same handler, an Anthropic-labelled engine not retried and an OpenAI-labelled one retried).

## ChatGPT: a request refused before it is sent (known fault, not fixed)

- **What happens:** a ChatGPT request refused before it is sent, for a reason other than the background-use consent (the sign-in token can't be refreshed, or the account's model list changed in that instant), ends the turn with nothing shown and nothing saved. `finishNativeCycle` in `src/agent/subscription-request-cycle.ts` drops the error reply along with the request's other held events.
- **What follows:** read from the page's code, not run: the record then owes a continuation, and the page continues by itself (`continueIfOwed` in `components/session-core.ts`).
- **Reproduced** on the server side with a scripted backend: the wire carries only `agent_start` and `agent_end`, and the saved record ends on the answer's tool result.

### The owner's decisions and approved words

- **Leave it, write it down.** Nothing is changed.
