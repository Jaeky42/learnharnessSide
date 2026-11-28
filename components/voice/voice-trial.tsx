"use client";
/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the GPT-Live
 * trial page's screen, on the server's site only (app/voice-trial/page.tsx).
 * A short spoken conversation driven by the app's own script, its captions,
 * the trial's one question, and "What the phone reports": the readout that
 * tells us how the live service and the phone behave. Nothing is saved.
 * The engine is components/voice/live-call.ts; the words are the builder's
 * trial words (src/core/voice/live.ts).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	formatUsd,
	LIVE_DEFAULT_MODEL,
	LIVE_DEFAULT_VOICE,
	LIVE_MODELS,
	LIVE_SPEAKER_LABEL,
	LIVE_VOICES,
	type LiveModel,
	type LiveVoice,
	optionLetter,
	VOICE_TRIAL_DONT_KNOW_LABEL,
	VOICE_TRIAL_QUESTION,
	VOICE_TRIAL_TEXT,
} from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { LiveCall, liveReportText, type LiveCallDeps, type LiveCallState, type PeerConnectionLike, type StreamLike } from "./live-call";

const buttonClass = "rounded-sm border border-border px-3 py-2 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const fieldClass = "w-full rounded-sm border border-border bg-background px-2 py-1.5 font-ui text-base text-foreground sm:text-sm";

function isStandalone(): boolean {
	const nav = navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

function browserDeps(onRemoteStream: (stream: unknown) => void): LiveCallDeps {
	return {
		createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
		getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints) as unknown as Promise<StreamLike>,
		fetch: (url, init) => fetch(url, { ...init, credentials: "same-origin", cache: "no-store" }),
		setTimeout: (run, ms) => window.setTimeout(run, ms),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
		now: () => Date.now(),
		onRemoteStream,
	};
}

/** The one line that says where the call is. */
export function stateLine(state: LiveCallState): string {
	switch (state.phase) {
		case "idle": return "Ready. Tap Start, then allow the microphone.";
		case "starting": return "Asking for the microphone…";
		case "connecting": return "Connecting…";
		case "ending": return "Ending…";
		case "ended": return state.endedText ?? "Call ended.";
		case "failed": return state.failure?.message ?? VOICE_TRIAL_TEXT.callFailed;
		case "live": {
			const paused = state.paused ? " Paused: speak to wake it." : "";
			if (state.step === "question") return `Answer by voice, or tap an option.${paused}`;
			if (state.step === "answered") return `Answered. Keep talking, or End.${paused}`;
			return `${state.hint ?? "The tutor is explaining."}${paused}`;
		}
	}
}

export function VoiceTrial() {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [call] = useState(() => new LiveCall(browserDeps((stream) => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.srcObject = stream as MediaStream | null;
		audio.play().then(
			() => callRef.current?.noteAudio("play() started"),
			(error: unknown) => callRef.current?.noteAudio(`play() refused: ${(error as { name?: string })?.name ?? "error"}`),
		);
	})));
	const callRef = useRef<LiveCall | null>(call);
	const state = useSyncExternalStore(call.subscribe, call.getState, call.getState);
	const [model, setModel] = useState<LiveModel>(LIVE_DEFAULT_MODEL);
	const [voice, setVoice] = useState<LiveVoice>(LIVE_DEFAULT_VOICE);
	const [copyNote, setCopyNote] = useState<string | null>(null);
	const reportRef = useRef<HTMLPreElement | null>(null);
	const detailsRef = useRef<HTMLDetailsElement | null>(null);
	const captionsRef = useRef<HTMLDivElement | null>(null);

	// The device, the page's visibility, and the ChatGPT hint: recorded whether a call runs or not.
	useEffect(() => {
		call.noteDevice({ standalone: isStandalone(), userAgent: navigator.userAgent });
		const visibility = () => call.noteVisibility(document.visibilityState);
		const hide = () => call.noteVisibility("pagehide");
		const show = (event: PageTransitionEvent) => call.noteVisibility(event.persisted ? "pageshow (from cache)" : "pageshow");
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		let alive = true;
		fetch("/api/voice-trial/chatgpt-models", { headers: { "x-learnharness-voice": "1" }, credentials: "same-origin", cache: "no-store" })
			.then((reply) => reply.json() as Promise<{ signedIn?: boolean; live?: string[]; error?: string }>)
			.then((body) => {
				if (!alive) return;
				if (body.error) call.noteChatGPTLive("couldn't be read");
				else if (!body.signedIn) call.noteChatGPTLive("not signed in");
				else call.noteChatGPTLive(body.live?.length ? body.live.join(", ") : "none");
			})
			.catch(() => { if (alive) call.noteChatGPTLive("couldn't be read"); });
		return () => {
			alive = false;
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", show);
			void call.end();
		};
	}, [call]);

	// The audio element's own reports.
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		const events = ["playing", "pause", "waiting", "stalled", "ended", "error", "emptied", "suspend"] as const;
		const handlers = events.map((type) => {
			const handler = () => call.noteAudio(type === "error" ? `error ${audio.error?.code ?? ""}`.trim() : type);
			audio.addEventListener(type, handler);
			return [type, handler] as const;
		});
		return () => { for (const [type, handler] of handlers) audio.removeEventListener(type, handler); };
	}, [call]);

	// Captions scroll with the words.
	const lines = state.captions.length;
	const lastLength = state.captions[lines - 1]?.text.length ?? 0;
	useEffect(() => {
		const box = captionsRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [lines, lastLength]);

	const active = state.phase === "starting" || state.phase === "connecting" || state.phase === "live";
	const start = () => { void call.start({ model, voice }); };

	const copy = useCallback(() => {
		const text = liveReportText(call.getState());
		const selectIt = () => {
			const details = detailsRef.current;
			if (details) details.open = true;
			const pre = reportRef.current;
			const selection = window.getSelection();
			if (pre && selection) {
				const range = document.createRange();
				range.selectNodeContents(pre);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			setCopyNote("Selected. Copy it from the menu.");
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => setCopyNote("Copied."), selectIt);
		else selectIt();
	}, [call]);

	const answer = state.answer;
	return (
		<div className="flex h-dvh min-w-0 flex-col" data-testid="voice-trial">
			<TopBar />
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-4">
					<header className="flex flex-col gap-1">
						<h1 className="font-ui text-base text-foreground">{VOICE_TRIAL_TEXT.title}</h1>
						<p className="text-sm text-muted-foreground">{VOICE_TRIAL_TEXT.intro}</p>
					</header>

					<section className="grid grid-cols-2 gap-3">
						<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
							Model
							<select className={fieldClass} value={model} disabled={active} onChange={(e) => setModel(e.target.value as LiveModel)} data-testid="voice-model">
								{LIVE_MODELS.map((id) => <option key={id} value={id}>{id}</option>)}
							</select>
						</label>
						<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
							Voice
							<select className={fieldClass} value={voice} disabled={active} onChange={(e) => setVoice(e.target.value as LiveVoice)} data-testid="voice-voice">
								{LIVE_VOICES.map((id) => <option key={id} value={id}>{id}</option>)}
							</select>
						</label>
					</section>

					<section className="flex flex-wrap gap-2">
						<button type="button" className={buttonClass} disabled={active || state.phase === "ending"} onClick={start} data-testid="voice-start">Start</button>
						<button type="button" className={buttonClass} disabled={!active} onClick={() => void call.end()} data-testid="voice-end">End</button>
						<button type="button" className={buttonClass} disabled={state.phase !== "live" && state.phase !== "connecting"} onClick={() => call.toggleMute()} aria-pressed={state.muted} data-testid="voice-mute">
							{state.muted ? "Unmute" : "Mute"}
						</button>
					</section>

					<p className={`font-ui text-sm ${state.phase === "failed" ? "text-error" : "text-foreground"}`} role="status" data-testid="voice-state">{stateLine(state)}</p>
					{state.phase === "failed" && state.failure?.detail && state.failure.kind !== "microphone" && (
						<p className="text-xs text-error [overflow-wrap:anywhere]" data-testid="voice-failure-detail">{state.failure.detail}</p>
					)}
					{state.muted && <p className="font-ui text-xs text-muted-foreground" data-testid="voice-mute-state">Microphone off{state.muteAck ? ` (the server says ${state.muteAck})` : ""}.</p>}

					{state.phase === "live" && state.step === "explaining" && !state.questionShown && (
						<button type="button" className={`${buttonClass} self-start`} onClick={() => call.showQuestion()} data-testid="voice-ask-now">Ask the question now</button>
					)}

					{state.questionShown && (
						<section className="flex flex-col gap-2 rounded-sm border border-border bg-card p-3" data-testid="voice-question">
							<p className="text-base text-foreground">{VOICE_TRIAL_QUESTION.prompt}</p>
							<div className="flex flex-col gap-2">
								{VOICE_TRIAL_QUESTION.options.map((option, i) => {
									const chosen = answer?.choice === i;
									const right = answer !== null && i === VOICE_TRIAL_QUESTION.correct;
									return (
										<button
											key={option}
											type="button"
											className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default ${chosen ? "border-foreground" : "border-border"} ${answer ? "" : "hover:bg-accent"}`}
											disabled={answer !== null || state.phase !== "live"}
											onClick={() => call.answer(i)}
											data-testid="voice-option"
											data-chosen={chosen ? "true" : undefined}
										>
											<span className="font-ui text-muted-foreground">{optionLetter(i)}</span>
											<span className="flex-1 text-foreground">{option}</span>
											{right && <span className="font-ui text-xs text-success">right</span>}
											{chosen && !right && <span className="font-ui text-xs text-error">chosen</span>}
										</button>
									);
								})}
								<button
									type="button"
									className={`rounded-sm border px-3 py-2 text-left text-sm text-muted-foreground transition-colors disabled:cursor-default ${answer?.choice === "dont-know" ? "border-foreground" : "border-border"} ${answer ? "" : "hover:bg-accent"}`}
									disabled={answer !== null || state.phase !== "live"}
									onClick={() => call.answer("dont-know")}
									data-testid="voice-dont-know"
								>
									{VOICE_TRIAL_DONT_KNOW_LABEL}
								</button>
							</div>
							{answer && (
								<p className={`font-ui text-xs ${answer.correct ? "text-success" : "text-error"}`} data-testid="voice-verdict">
									{answer.choice === "dont-know" ? "You said you don't know." : answer.correct ? "Correct." : "Not quite."} Answered by {answer.by === "voice" ? "voice" : "tap"}.
								</p>
							)}
						</section>
					)}

					<section className="flex flex-col gap-1">
						<h2 className="font-ui text-xs text-muted-foreground">Captions</h2>
						<div ref={captionsRef} className="flex max-h-72 min-h-24 flex-col gap-1.5 overflow-y-auto rounded-sm border border-border p-3 text-sm" data-testid="voice-captions">
							{state.captions.length === 0
								? <p className="text-muted-foreground">The words of both of you show here.</p>
								: state.captions.map((line, i) => (
									<p key={i} className="text-foreground" data-speaker={line.speaker}>
										<span className="font-ui text-xs text-muted-foreground">{LIVE_SPEAKER_LABEL[line.speaker]}: </span>{line.text}
									</p>
								))}
						</div>
					</section>

					<details ref={detailsRef} className="rounded-sm border border-border p-3" data-testid="voice-readout">
						<summary className="cursor-pointer font-ui text-sm text-foreground">What the phone reports</summary>
						<div className="mt-2 flex flex-col gap-2">
							<p className="font-ui text-xs text-muted-foreground">
								Session time {state.diag.usage ? `${state.diag.usage.seconds}s` : "–"}; cost so far {state.diag.cost === null ? "–" : formatUsd(state.diag.cost)} at the listed prices.
							</p>
							<pre ref={reportRef} className="max-h-96 overflow-auto whitespace-pre-wrap font-ui text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" data-testid="voice-report">{liveReportText(state)}</pre>
							<div className="flex items-center gap-3">
								<button type="button" className={buttonClass} onClick={copy} data-testid="voice-copy">Copy report</button>
								{copyNote && <span className="font-ui text-xs text-muted-foreground">{copyNote}</span>}
							</div>
						</div>
					</details>
				</div>
			</main>
			<audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="voice-audio" />
		</div>
	);
}
