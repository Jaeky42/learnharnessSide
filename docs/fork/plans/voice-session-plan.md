# Voice sessions: a draft plan (not approved, nothing built)

A third kind of session, beside Teaching and Practice: a lesson held as a spoken conversation on the phone. The learner's chosen model prepares the lesson; a speech-to-speech model delivers it; the lesson's questions show in the app's question box and are answered by voice or by tap.

**State:** the owner has made the eight decisions below, one question each. The plan itself (the phases, and the smaller rules proposed with it) is waiting for the owner's approval. Change a decision only with the owner's approval.

## The owner's decisions

| # | About | Decision |
|---|---|---|
| 1 | Who teaches | **"My model prepares, voice delivers."** The learner's chosen model (GPT-6.2 Astra, Sol, Fable, …) decides what is taught: the plan, the content of each step and the questions with their correct answers. A voice model speaks it and handles the back-and-forth; what goes off-script is put to the learner's model, with a wait of a few seconds. Chosen over the voice model teaching alone (the owner: "wouldn't that mean i'd have no underlying control of which model is being used to teach me?"), over the learner's model answering every turn (waits of 5 to 30 seconds), and over a pipeline with no speech-to-speech model. |
| 2 | The voice model | **OpenAI Realtime.** Chosen over Gemini Live, over Deepgram's Voice Agent (a managed pipeline, not speech-to-speech; the owner asked "does deepgram have a voice model?"), and over trying two on the iPhone first. |
| 3 | Where it lives | **Its own kind of session**, a third choice beside Teaching and Practice. Not a switch inside a teaching lesson; a typed lesson can't be continued by voice or the other way round. |
| 4 | What it is for | **A full lesson on a new topic:** it checks what the learner knows, the learner's model makes a plan, and it teaches step by step with questions. Chosen over a review of earlier sessions, and over both. |
| 5 | Answering a question | **Sent at once; the voice asks back when unsure.** A clear spoken answer is marked in the question box and submitted straight away. A tap on the box always works. The owner was told that a misheard answer can be submitted and graded. Chosen over "marked, then I confirm" and over tap only. |
| 6 | The screen | **A board plus live captions.** The board shows a formula, a diagram or a figure the learner's model prepared, as the voice gets to it; under it both sides' words appear as text while they are spoken. Chosen over the board alone and over voice only. |
| 7 | The microphone | **Always listening, and the learner can interrupt.** A mute button. If the iPhone trial shows that this misbehaves on the loudspeaker, the owner is asked again; nothing is switched quietly. Chosen over "no interrupting" and over tap to talk. |
| 8 | Devices | **The server's site: phone, tablet and a computer's browser.** The screen is designed for the phone. The Windows app lists Voice sessions and shows their text, and can't start or continue one. One OpenAI key, on the server. Chosen over the Windows app too, and over the phone only. |

Earlier in the same conversation the owner chose the direction: "i'd want it to be like option c, where it's like a natural conversation. this would primarily be a phone feature".

## How it works

```
 phone (the server's site)                        the app's server (the account's copy)
 ┌──────────────────────────────┐                ┌─────────────────────────────────────┐
 │ Voice screen                 │  answers,      │ the lesson underneath:              │
 │  board · captions            │  transcript    │  the prober, then the teacher,      │
 │  question box (QuestionDock) │ ─────────────► │  on the learner's chosen model      │
 │                              │ ◄───────────── │  (plan, steps, questions, grading   │
 │  voice call engine           │  next step,    │   data), saved as a lesson record   │
 │   tools the voice model calls│  questions     │                                     │
 └───────┬──────────────────────┘                │ mints a one-minute key for the call │
         │ WebRTC call: sound both ways,         └──────────────┬──────────────────────┘
         │ events on a data channel                             │ OPENAI_API_KEY stays here
         ▼                                                      ▼
   OpenAI Realtime (the voice model)  ◄──── /v1/realtime/client_secrets
```

- **The lesson underneath is an ordinary lesson loop.** The prober and the teacher run on the learner's chosen model through the existing turn machinery (`handleChatInput`), with prompt fragments written for a lesson that will be spoken. Each turn produces a step: what to teach (a brief for the voice model, not polished prose), anything for the board, and usually a question through the existing question tools (`probe`, `recall`, `quiz`, `explain`, `ask_user_question`), which already commit the correct answer and an explanation before the learner sees the question.
- **The voice model delivers the step.** It is told the step, speaks it in its own words, shows board items when it reaches them, reads the question, and takes the answer.
- **How the wait is hidden.** A question's correct answer and explanation are already in the step, so the voice responds to an answer at once ("right, because …"). The answer goes to the server at the same moment, and the learner's model prepares the next step while the voice is still talking. When the next step isn't ready in time, the voice says so and bridges. Some waits of a few seconds will remain; how often is not known until it is tried.
- **Off-script questions** go to the learner's model through upstream's side-question machinery (`src/server/side-chat.ts`: one model call, no tools, the lesson as context). The teacher receives each such exchange with its next turn, as it does for the Tutor.
- **What was said** (both sides, as text) is saved in the record for the captions, the read-only view and resuming. What the learner said outside a question reaches the teacher with its next turn, as a marker message.
- **The key.** `OPENAI_API_KEY` already has a row in Settings (it is one of the model-provider keys, `AUTH_PROVIDER_KEYS` in `src/core/auth-keys.ts`). The server mints a one-minute client secret per call, as it mints a Deepgram token today (`app/api/stt/token/route.ts`); the browser never holds the key. Sound travels between the phone and OpenAI directly.

## What the investigation found

**In the code** (read, not run):

- `ChatKind` is `"teach" | "practice"`, an optional field of `ChatRecord` (`src/core/contracts/chat.ts`); absent reads as teach, and almost every check is `=== "practice"`. A reader refuses only a record whose `version` is newer than it knows; an unknown marker type passes through to the model as a user message.
- The page for a session (`app/chat/[id]/page.tsx`) passes `kind` to `Chat` and doesn't branch on it. The home screen has the Teach / Practice toggle (`components/home.tsx`); the session list has a kind filter (`components/sidebar.tsx`).
- `QuestionDock` (`components/question-dock.tsx`) imports nothing from the lesson screen and uses no context, so another screen can mount it with its props. Grading is pure code in `src/core/question-core.ts`.
- Lesson Markdown is drawn by `MessageResponse` (`components/ai-elements/message.tsx`), which the board can reuse (formulas, tables, diagrams).
- The agents are built in `src/agent/teacher-agent.ts` (`createProberAgent`, `createTeacherAgent`, `createPracticeAgent`, one `baseAgentOptions`), with instructions composed per kind from `src/agent/prompts/`.
- A turn's usage is appended with `appendTurnUsage`; graph extraction runs after a turn for every session that isn't practice, and reads the teacher's prose from `record.messages`.
- Sync sends a session's files whole; `sessionWritePath` covers any write under `/api/chats/<id>/…` (so a new `voice/…` route is refused on a session another device holds, with no new code); the guarded stores wrap the record's writers.

**About OpenAI Realtime** (from search summaries of OpenAI's own documentation site; the pages themselves could not be opened from the development sandbox, so every item is to be confirmed against the live service in Phase 0):

- A browser connects as a WebRTC call: the server creates a client secret (`POST /v1/realtime/client_secrets`, expiring after one minute), the browser posts its offer to `/v1/realtime/calls` with it, and events travel on a data channel named `oai-events`.
- Tools: the model's call arrives in `response.function_call_arguments.done` / `response.done`; the client answers with a `function_call_output` item (`conversation.item.create`) and `response.create`. `session.update` changes the instructions during a session.
- A session lasts at most 60 minutes. The context window is 32k tokens on the first `gpt-realtime` and 128k from `gpt-realtime-2` on; beyond it the oldest items are dropped.
- Turn detection: `server_vad` or `semantic_vad` (with an `eagerness` setting); `interrupt_response` for speaking over the model.
- Listed prices per million tokens: `gpt-realtime-2.1` audio 32 in, 0.40 cached, 64 out (text 4 / 0.40 / 24); `gpt-realtime-2.1-mini` audio 10 / 0.30 / 20 (text 0.60 / 0.06 / 2.40). Third-party estimates put a conversation at about 0.04 to 0.10 dollars a minute on the larger model.
- **Not established:** the events that carry each side's words as text (for the captions), which voices exist, whether the session's settings can be fixed when the secret is minted, and what OpenAI's separate "GPT-Live" product (billed per minute, with a "delegation" guide) offers. Phase 0 answers the first three; the fourth is read before Phase 1 and put to the owner only if it would change a decision.

**About the iPhone** (bug reports, not confirmed behaviour): a home-screen app loses the microphone and its sound when it leaves the screen, so a Voice session runs only while the app is open and the phone unlocked. Open WebKit reports describe the microphone failing after a relaunch, sound not playing on reopen, and crackling while the microphone is on with echo cancelling (bug 326286). A WebRTC call lets the phone handle the sound itself, which may avoid the path those reports are about. Only the owner's iPhone can show it.

## The phases

Each phase ends as the fork's phases do: tests, `npm test`, typecheck and lint, a browser run in server mode, a commit, and a list of what to try.

### Phase 0: the iPhone trial (decides whether the rest is built)

A page on the server's site, reached only by its address, behind the login, server mode only. It holds a short conversation with OpenAI Realtime: a fixed short script, one multiple-choice question answered by voice, live captions, a mute button, and a readout of what the phone reports. No lesson, nothing saved.

- **Built:** the mint route, the call engine (`RTCPeerConnection`, the data channel, the events), one tool round trip, the captions.
- **It confirms** the facts marked as not established above, and on the owner's iPhone: that it hears and is heard, that the sound is clean on the loudspeaker and with headphones, that interrupting works, and what happens after the app is left, closed and reopened, and the phone locked.
- **The owner enters an OpenAI API key** in Settings on the server's site. Never in chat.
- **It goes to the server's branch only**, with the owner's approval, and is removed or kept hidden afterwards. The Windows app gets nothing; the sync protocol is untouched.
- **Then the owner decides:** go on, go on with a change (decision 7 has its own fallback), or stop. Also chosen then, by ear: which voice, and the larger or the mini voice model.

### Phase 1: the lesson underneath

- `ChatKind` gains `"voice"`; the create route and the store accept it.
- Voice variants of the prober's and the teacher's instructions (new fragments under `src/agent/prompts/`): write a brief to be spoken, keep steps short, say what goes on the board. **The prompt texts are drafted and shown to the owner for approval before they ship.**
- A board tool for the teacher (server-executed; it records an item: a title and Markdown).
- The record keeps the spoken transcript and the board items (new optional fields; chat format stays 2), and a marker type that carries what the learner said outside a question to the teacher's next turn.
- Routes under `/api/chats/<id>/voice/`: mint a call's secret with the session's current state; append transcript; record the voice model's usage.
- The voice model's instructions and tool list, built on the server from the lesson's state (pure functions, tested): the step to deliver, the pending question, the board items, the last lines of the conversation for a resumed call.
- Tests with scripted models, through the real `handleChatInput`.

### Phase 2: the Voice screen

- Starting one: a third choice beside Teaching and Practice. The screen: top bar, board, captions, question box, a sound meter, mute and end.
- The call: start from a tap, the tools (`show on the board`, `pose the question`, `submit the answer`, `ask the teacher`, `next step`), captions as the words arrive, interruption.
- Answers: the rules of decision 5 as pure code (a letter, an ordinal, "I don't know", an explanation in words; unclear means ask back), marked in the real `QuestionDock` and submitted through the session's own answer path.
- Leaving and coming back: the call ends when the app leaves the screen; reopening shows the session with a button to continue, and a new call is primed with where the lesson stands. The same at OpenAI's 60-minute limit, by itself.
- Failures in words: no key, the microphone refused, the call dropped.
- Browser runs at phone size with a scripted stand-in for the call.

### Phase 3: around it, and the ship

- The session list and its filter; the read-only view of a Voice session in the Windows app (the transcript, the board items, the questions and answers).
- Sync run with two copies; a session another device holds moves here when Start is pressed (seamless sessions); accounts on one server (each account's copy has its own key).
- The voice model's cost in the session's meter.
- The docs: a topic file `docs/fork/voice.md`, the map, `status.md`, the list of upstream files edited.
- An independent review of the mint route and the key handling; then both branches, with the owner's approval, the server first; and a "what to try on your iPhone" page.

## Smaller rules proposed with the plan (for the owner to approve or change)

1. **The name on screen is "Voice".** Every other word on screen is drafted in its phase and approved before it ships.
2. **The learner's model and its thinking level** are picked as in a Teaching session, per session.
3. **Which voice, and the larger or the mini voice model,** are chosen by the owner after hearing them in Phase 0, then kept as per-device settings.
4. **No helpers in the first version:** no research, demos, generated figures or PDF reading in a Voice session. The board shows what the lesson's Markdown can draw: text, formulas, tables, diagrams.
5. **The confidence bar and the "thinking" field are not asked for by voice.** They can be set by tap before the answer is spoken; otherwise the confidence bar keeps its default.
6. **No typing in a Voice session** in the first version.
7. **A silent session pauses itself** after 3 minutes with nobody speaking (the call is closed; a tap continues), so an open microphone doesn't keep costing.
8. **Graph extraction is on,** as for a Teaching session.
9. **No Tutor and no notes drawer** on the Voice screen in the first version.
10. **The sync protocol stays 3 and the chat format stays 2.** The new kind and fields are optional additions an older build can read. An older Windows app would show a Voice session as an ordinary lesson until it updates, so the server and the app are shipped the same day, the server first.
11. **Language:** the voice follows the language the learner speaks; the captions' recognition follows the dictation language setting. To be confirmed in Phase 0.

## Risks and limits the owner has been told

- **The iPhone's home-screen app** is the largest risk; Phase 0 exists for it. A Voice session can't run from a locked phone or in the background.
- **The voice model may not keep to the prepared step:** it may answer by itself where it should ask the teacher, or skip a question. Unproven until tried; the prompt and the tools are the only controls.
- **Waits of a few seconds** between steps will sometimes be heard.
- **A misheard answer can be submitted and graded** (decision 5).
- **Cost:** the voice model is paid by use on an OpenAI API key, on top of the learner's own model. Third-party estimates: roughly 2.50 to 6 dollars an hour on the larger voice model, less on the mini.
- **Privacy:** the sound goes from the phone to OpenAI. The transcript is stored in the session and syncs with it.
- **Upstream merges:** new edits to upstream's files (the home screen's toggle, the session page, the session list, the record's type, the create route and store, the agents' instruction composer). Everything else is in the fork's own files.
- **OpenAI's API facts are from search summaries,** not from the pages.

## How the work is assigned (the orchestration policy in `CLAUDE.md`)

- Phase 0: one `complex-implementer` (Opus, high) for the call engine and the mint route; `test-verifier` (Sonnet, medium).
- Phase 1: one `complex-implementer` for the server side; one `routine-implementer` (Sonnet, medium) for the pure rules and their tests, with separate files; `test-verifier`.
- Phase 2: one `complex-implementer` for the call and its tools; one `routine-implementer` for the screen; `test-verifier`.
- Phase 3: `routine-implementer`s; one `deep-reviewer` (Opus, high) pass on the mint route, the key handling and the sync touchpoints.
- The lead plans, dispatches and assesses each phase's evidence; a source-level review by the lead only where the review policy's triggers apply.
