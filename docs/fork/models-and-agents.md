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
