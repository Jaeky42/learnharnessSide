"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and ✕ all close. Modal-only — /settings redirects, so
 *   nothing links into a dead surface.
 * - Left section nav in the app's mono chrome, with small decorative
 *   Lucide icons for the built-in sections; active = bg-accent. Icons
 *   inherit the row's color, without a separate palette.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	Fragment,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefObject,
} from "react";
import { BotIcon, CloudIcon, KeyIcon, KeyboardIcon, NotebookPenIcon, PaletteIcon, PlugIcon, PuzzleIcon, SettingsIcon, UserIcon, WaypointsIcon, type LucideIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useInteractionLayers, type CloseOutcome } from "@/components/interaction-layers";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { Hint } from "@/components/ui/hint";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { PluginsSection } from "./plugins-section.tsx";
import { PluginSettingsPage } from "./plugin-settings-page.tsx";
import { usePlugins } from "@/components/plugins";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";
import { AccountSection, useServerAccount } from "./account-section.tsx";
import { ObsidianSection } from "./obsidian-section.tsx";
import { CloudSection } from "./cloud-section.tsx";
import { CloudServerSection } from "./cloud-server-section.tsx";
import { isPhoneNow, useIsPhone } from "@/components/phone/use-phone";
import { isPluginSettingsSection } from "@/components/phone/phone-plugins";
import { isServerMode } from "./server-mode";

/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys", label: "Providers", icon: KeyIcon },
	{ id: "agent", label: "Agent", icon: BotIcon },
	{ id: "appearance", label: "Appearance", icon: PaletteIcon },
	{ id: "graph", label: "Graph", icon: WaypointsIcon },
	{ id: "keyboard", label: "Keyboard", icon: KeyboardIcon, hint: "Stored on this device" },
	{ id: "general", label: "General", icon: SettingsIcon },
	// Side-tutor fork: Obsidian and Account are shown only on a server-mode
	// LearnHarness (obsidian-section.tsx, account-section.tsx). Cloud (cloud
	// sync Phase 6) is shown everywhere: the desktop app's pairing and sync
	// state (cloud-section.tsx), the server's paired desktop apps
	// (cloud-server-section.tsx).
	{ id: "obsidian", label: "Obsidian", icon: NotebookPenIcon },
	{ id: "cloud", label: "Cloud", icon: CloudIcon },
	{ id: "account", label: "Account", icon: UserIcon },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"] | "plugins" | "core-plugins" | `plugin:${string}`;
/** PHONE: the closing fade's length; app/phone.css uses the same 150ms. */
const SETTINGS_FADE_MS = 150;

/** PHONE (Phase 3): Settings fades out on close as well as in (owner's
 *  choice). The dialog itself closes at once, so its interaction layer is
 *  gone as soon as it reports "closed"; the fade plays on an inert copy of
 *  the dialog's contents, which app/phone.css animates through
 *  data-phone-closing and which is removed when the fade ends. Returns the
 *  copy, or null where nothing fades (not a phone, or reduced motion). */
function fadeOutCopy(frame: HTMLElement | null): HTMLElement | null {
	if (!frame || !isPhoneNow()) return null;
	if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
	// HostDialog renders the frame directly inside the backdrop.
	const backdrop = frame.parentElement;
	if (!backdrop) return null;
	const copy = backdrop.cloneNode(true) as HTMLElement;
	for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
	copy.setAttribute("data-phone-closing", "");
	copy.setAttribute("aria-hidden", "true");
	copy.setAttribute("inert", "");
	copy.style.pointerEvents = "none";
	// The dialog paints at its interaction layer's rank; the copy keeps it.
	const layer = backdrop.closest<HTMLElement>("[data-interaction-layer]");
	if (layer?.style.zIndex) copy.style.zIndex = layer.style.zIndex;
	const copiedFrame = copy.querySelector<HTMLElement>('[data-phone="settings"]');
	copiedFrame?.setAttribute("data-phone-closing", "");
	frame.ownerDocument.body.append(copy);
	// A copy doesn't carry scroll positions: keep the list and the section where they were.
	for (const testid of ["settings-nav", "settings-content"]) {
		const from = frame.querySelector(`[data-testid="${testid}"]`);
		const to = copiedFrame?.querySelector(`[data-testid="${testid}"]`);
		if (from && to) to.scrollTop = from.scrollTop;
	}
	window.setTimeout(() => copy.remove(), SETTINGS_FADE_MS);
	return copy;
}

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });
// Authority belongs to the persistent Settings host, not a particular field or
// open/close lifetime: a delayed response must not roll back a newer ACK.
interface SettingsWriteOrder {
	issued: number;
	acknowledged: number;
	record?: UserSettings;
	fileAccessError?: string | null;
	listeners: Set<(record: UserSettings, fileAccessError: string | null) => void>;
}
const WriteOrderContext = createContext<RefObject<SettingsWriteOrder> | null>(null);

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const interactions = useInteractionLayers();
	const layerId = useId();
	const writeOrder = useRef<SettingsWriteOrder>({ issued: 0, acknowledged: 0, listeners: new Set() });
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const [navigationRequest, setNavigationRequest] = useState(0);
	// PHONE (Phase 3): a link to a specific section opens straight on it;
	// plain "Settings" opens on the section list.
	const [landOnExplicit, setLandOnExplicit] = useState(false);
	// PHONE (Phase 3): the dialog's frame, copied for the closing fade, and
	// the copy while it fades.
	const frameRef = useRef<HTMLDivElement | null>(null);
	const fadingCopy = useRef<HTMLElement | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		// Returning to this singleton is a bounded request, not a forced pop.
		// Controlled layers may accept closure before React commits it.
		if (interactions.getLayer(layerId) && interactions.popTo(layerId) !== "closed") return;
		interactions.invalidateOpening();
		fadingCopy.current?.remove();
		fadingCopy.current = null;
		// Side-tutor fork: plugins are hidden on a phone, so a link to a
		// plugin section opens on the section list instead.
		if (section && isPhoneNow() && isPluginSettingsSection(section)) section = undefined;
		setNavigationRequest(request => request + 1);
		setLandOn(section ? section as SectionId : "keys");
		setLandOnExplicit(!!section);
		setLandOnRow(row ?? null);
		setShow(true);
	}, [interactions, layerId]);
	const close = useCallback((): CloseOutcome => {
		// Only the first close of an open dialog fades (its frame is still mounted).
		if (frameRef.current && !fadingCopy.current?.isConnected) fadingCopy.current = fadeOutCopy(frameRef.current);
		setShow(false);
		return "closed";
	}, []);
	useEffect(() => () => { fadingCopy.current?.remove(); }, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	useEffect(() => {
		const onPluginSettings = (event: Event) => {
			const pluginId: unknown = (event as CustomEvent<unknown>).detail;
			if (typeof pluginId === "string") open(`plugin:${pluginId}`);
		};
		window.addEventListener("lh:open-plugin-settings", onPluginSettings);
		return () => window.removeEventListener("lh:open-plugin-settings", onPluginSettings);
	}, [open]);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><WriteOrderContext.Provider value={writeOrder}><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={close} initialSection={landOn} initialRow={landOnRow} navigationRequest={navigationRequest} layerId={layerId}
					phoneOpensSection={landOnExplicit} frameRef={frameRef} />
			)}
		</DialogContext.Provider></WriteOrderContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
	navigationRequest,
	layerId,
	phoneOpensSection,
	frameRef,
}: {
	onClose: () => CloseOutcome;
	initialSection: SectionId;
	navigationRequest: number;
	layerId: string;
	/** The keys-section row to unfold (see DialogContext above). */
	initialRow: string | null;
	phoneOpensSection: boolean;
	frameRef: Ref<HTMLDivElement>;
}) {
	// Keep the original visual frame and plain dim backdrop. The shared
	// untransformed boundary also contains this modal's portaled menus.
	return <SettingsDialogBody onClose={onClose} initialSection={initialSection}
		initialRow={initialRow} navigationRequest={navigationRequest}
		phoneOpensSection={phoneOpensSection} frameRef={frameRef}
		renderFrame={frame => <HostDialog open layerId={layerId} ownerId={null}
			onClose={onClose} frame={frame} aria-label="Settings"
			backdropProps={{
				className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80",
				"data-testid": "settings-backdrop",
			}}>{frame.props.children}</HostDialog>} />;
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
	navigationRequest = 0,
	renderFrame,
	phoneOpensSection = false,
	frameRef,
}: {
	onClose: () => void;
	/** The runtime supplies the shared modal shell; standalone SSR retains the frame. */
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
	initialSection?: SectionId;
	/** Repeated opens must retarget even when the requested section is unchanged. */
	navigationRequest?: number;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
	/** PHONE: open straight on initialSection instead of the section list. */
	phoneOpensSection?: boolean;
	/** PHONE: the frame, for the closing fade (SettingsDialogProvider). */
	frameRef?: Ref<HTMLDivElement>;
}) {
	const { onAppearanceChange } = useAppearance();
	const inheritedWriteOrder = useContext(WriteOrderContext);
	const standaloneWriteOrder = useRef<SettingsWriteOrder>({ issued: 0, acknowledged: 0, listeners: new Set() });
	const writeOrder = inheritedWriteOrder ?? standaloneWriteOrder;
	const { snapshot } = usePlugins();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [fileAccessError, setFileAccessError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	const account = useServerAccount();
	// A deep-link fired while the dialog is ALREADY open (first exercised by
	// the wave-6 embedding picker's "Add a provider key first…" link — the
	// picker itself died with wave 7, the mechanism is general) changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection, navigationRequest]);
	// PHONE (cloud sync Phase 3): full screen, the section list first, then
	// the section with a back arrow. Keyboard shortcuts are hidden there.
	const phone = useIsPhone();
	const [phoneScreen, setPhoneScreen] = useState<"list" | "section">(phoneOpensSection ? "section" : "list");
	useEffect(() => {
		if (phoneOpensSection) setPhoneScreen("section");
	}, [initialSection, phoneOpensSection, navigationRequest]);
	// Side-tutor fork: no plugin rows on a phone (decision "Hide the ways in");
	// a plugin section still open when the layout turns into the phone one
	// goes back to the list. Links are turned away in open() above.
	const phonePluginSection = phone && isPluginSettingsSection(active);
	useEffect(() => {
		if (!phonePluginSection) return;
		setActive("keys");
		setPhoneScreen("list");
	}, [phonePluginSection]);

	const enabledPlugins = snapshot.plugins.filter(plugin => plugin.info.enabled);
	const activePluginId = active.startsWith("plugin:") ? active.slice("plugin:".length) : null;
	const activePlugin = enabledPlugins.find(plugin => plugin.info.id === activePluginId);
	// Keep a deep link pending while discovery loads. Once discovery settles,
	// disabled/uninstalled destinations return to management, never stale DOM.
	const missingPlugin = activePluginId !== null && !activePlugin && !snapshot.loading;
	const management = snapshot.plugins.find(plugin => plugin.info.id === activePluginId)?.info.origin === "core" ? "core-plugins" : "plugins";
	useEffect(() => {
		if (missingPlugin) setActive(management);
	}, [missingPlugin, management]);
	const selected = missingPlugin ? management : active;
	// Side-tutor fork: the server-only rows (on a phone, Account shows from
	// the first frame on the server, from the lh_server cookie, so it doesn't
	// pop into the list once the device list arrives), and no Keyboard row on
	// a phone.
	const nativeSections = SECTIONS.filter((s) =>
		(s.id !== "account" || account.devices || (phone && account.devices === undefined && isServerMode())) &&
		(s.id !== "obsidian" || isServerMode()) &&
		!(phone && s.id === "keyboard"));
	// Side-tutor fork: a phone lists no plugin rows (and so none of the
	// dividers that set them apart below).
	const navSections: { id: SectionId; label: string; icon?: LucideIcon }[] = phone ? [...nativeSections] : [
		...nativeSections,
		{ id: "core-plugins", label: "Core plugins", icon: PlugIcon },
		{ id: "plugins", label: "Community plugins", icon: PuzzleIcon },
		...enabledPlugins.map(plugin => ({ id: `plugin:${plugin.info.id}` as const, label: plugin.info.manifest?.name ?? plugin.info.id })),
	];
	const activeLabel = navSections.find((s) => s.id === selected)?.label ?? "Settings";

	// A save may finish after its original dialog closes. Publish its
	// acknowledged snapshot to whichever Settings instance is mounted now.
	useEffect(() => {
		const authority = writeOrder.current;
		const apply = (record: UserSettings, fileAccessError: string | null) => {
			setRecord(record);
			setFileAccessError(fileAccessError);
		};
		authority.listeners.add(apply);
		return () => { authority.listeners.delete(apply); };
	}, [writeOrder]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT.
	// A GET started before a newer acknowledged save cannot roll it back.
	useEffect(() => {
		const authority = writeOrder.current;
		const acknowledgedAtRead = authority.acknowledged;
		let alive = true;
		const applyLoaded = (loaded: UserSettings | null, fileAccessError: string | null = null) => {
			if (!alive) return;
			const unchanged = authority.acknowledged === acknowledgedAtRead;
			setRecord(unchanged ? loaded : authority.record ?? loaded);
			setFileAccessError(unchanged ? fileAccessError : authority.fileAccessError ?? null);
		};
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null; fileAccessError?: string }) =>
				applyLoaded(body.settings ?? { version: CURRENT_SETTINGS_VERSION }, body.fileAccessError ?? null),
			)
			.catch(() => applyLoaded(null));
		return () => { alive = false; };
	}, [writeOrder]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		): Promise<boolean> => {
			const ticket = ++writeOrder.current.issued;
			setError(null);
			try {
				const res = await fetch(`/api/settings/${section}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const detail = (await res.json().catch(() => ({}))) as {
						error?: string;
					};
					if (ticket === writeOrder.current.issued) setError(`${section}: ${detail.error ?? res.status}`);
					return false;
				}
				// Only the acknowledged record is canonical: never substitute the
				// request body, including when normalization leaves the old value.
				const reply = (await res.json().catch(() => null)) as { settings?: UserSettings; fileAccessError?: string } | null;
				const stored = reply?.settings;
				if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== 1 ||
					!stored[section] || typeof stored[section] !== "object" || Array.isArray(stored[section])) {
					if (ticket === writeOrder.current.issued) setError(`${section}: Could not confirm saved settings. Your input has been kept.`);
					return false;
				}
				if (ticket >= writeOrder.current.acknowledged) {
					writeOrder.current.acknowledged = ticket;
					writeOrder.current.record = stored;
					writeOrder.current.fileAccessError = reply?.fileAccessError ?? null;
					for (const apply of writeOrder.current.listeners) apply(stored, writeOrder.current.fileAccessError);
					// Every accepted response is a full canonical record, including
					// appearance saved by an earlier, still-pending section request.
					onAppearanceChange(stored.appearance);
				}
				notifySettingsSaved(section);
				return true;
			} catch (error) {
				if (ticket === writeOrder.current.issued) setError(`${section}: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		},
		[onAppearanceChange, writeOrder],
	);

	const frame = (
		<div
			ref={frameRef}
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			data-phone="settings"
			data-phone-screen={phone ? phoneScreen : undefined}
			className="settings-dialog-pop flex h-[620px] max-h-[85vh] w-[920px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				{phone && phoneScreen === "section" && (
					<button
						type="button"
						data-phone="settings-back"
						aria-label="Back to all settings"
						onClick={() => setPhoneScreen("list")}
						className="-ml-2 flex items-center gap-1 rounded-md py-2 pr-2 font-title text-2xl tracking-tight"
					>
						<svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
							<path d="M10 3L5 8l5 5" />
						</svg>
						{activeLabel}
					</button>
				)}
				<h2 data-phone="settings-title" className="font-title text-2xl tracking-tight">Settings</h2>
				<Hint
						// Esc closes through the shared interaction owner.
						label="Close"
						binding="escape"
						side="left"
					>
						<button
					type="button"
					aria-label="Close settings"
					data-testid="settings-close"
					className="ml-auto size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onClose}
				>
					<svg
						viewBox="0 0 16 16"
						className="mx-auto size-3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
				</button>
					</Hint>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* Left nav — mono labels and theme-inherited decorative icons,
					    active = bg-accent. The rows are the nav's own children
					    (app/phone.css styles them as `nav > button` on a phone);
					    the dividers sit between them. */}
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className="flex min-h-0 w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2"
				>
					{navSections.map((s, index) => (
						<Fragment key={s.id}>
							<button
								type="button"
								data-testid={`settings-nav-${s.id}`}
								aria-current={selected === s.id}
								className={`flex w-full shrink-0 items-center gap-2 break-words rounded-sm px-3 py-1.5 text-left font-ui text-sm transition-colors ${
									selected === s.id
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground"
								}`}
								onClick={() => {
									setActive(s.id);
									setPhoneScreen("section");
								}}
							>
								{s.icon && <s.icon aria-hidden="true" focusable="false" className="size-3.5 shrink-0" />}
								<span className="min-w-0">{s.label}</span>
							</button>
							{/* After the last native/fork row: the plugin management rows follow. */}
							{!phone && index === nativeSections.length - 1 && <hr className="my-2 shrink-0 border-border" />}
							{s.id === "plugins" && <hr className="my-2 shrink-0 border-border" />}
						</Fragment>
					))}
				</nav>

				{/* Content column — one section at a time, this scrolls — and
				    LOCKS while any MenuShell is open (owner ruling: no
				    scrolling with a dropdown down; MenuShell announces
				    open/close, the count keeps overlap honest). The lock
				    intercepts wheel/touch instead of hiding the scrollbar —
				    nothing may shift when the lock engages. */}
				<div
					ref={contentRef}
					className="min-w-0 flex-1 overflow-y-auto"
					data-testid="settings-content"
				>
					{error && !activePluginId && selected !== "plugins" && selected !== "core-plugins" && (
						<p
							role="alert"
							className="m-4 rounded-sm border border-error/40 px-3 py-2 text-xs text-error"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{selected === "plugins" || selected === "core-plugins" ? <PluginsSection origin={selected === "core-plugins" ? "core" : "community"} onOpenSettings={pluginId => setActive(`plugin:${pluginId}`)} />
						: activePlugin ? <PluginSettingsPage key={`${activePlugin.info.id}/${activePlugin.info.revision}`} plugin={activePlugin} />
							: activePluginId !== null ? <p role="status" className="px-6 py-5 text-xs text-muted-foreground">Loading plugins…</p>
								: record === undefined ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Loading settings…
						</p>
					) : record === null ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Settings could not be loaded — refresh to retry.
						</p>
					) : (
						<div>
							{active === "general" && (
								<SettingsSection
									title="General"
									testid="section-general"
								>
									<UpdateSettings
										autoUpdate={record.general?.autoUpdate ?? true}
										onAutoUpdateChange={(on) =>
											void write("general", { ...record.general, autoUpdate: on })
										}
									/>
								</SettingsSection>
							)}
							{active === "obsidian" && isServerMode() && (
								<SettingsSection title="Obsidian" testid="section-obsidian">
									<ObsidianSection />
								</SettingsSection>
							)}
							{active === "cloud" && (
								<SettingsSection title="Cloud" testid="section-cloud">
									{isServerMode() ? <CloudServerSection /> : <CloudSection />}
								</SettingsSection>
							)}
							{active === "account" && account.devices && (
								<SettingsSection title="Account" testid="section-account">
									<AccountSection devices={account.devices} reload={account.reload} />
								</SettingsSection>
							)}
							{/* PHONE: the Account row shows from the first frame on the
							    server (the lh_server cookie), so it doesn't pop into the
							    list once the device list arrives. */}
							{active === "account" && account.devices === undefined && (
								<p className="px-6 py-5 text-xs text-muted-foreground/70">Loading…</p>
							)}
							{active === "keys" && (
								<SettingsSection title="Providers" testid="section-keys">
									<KeysSection initialRow={initialRow ?? undefined} />
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection
									title="Agent"
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										fileAccessError={fileAccessError}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection
									title="Appearance"
									testid="section-appearance"
								>
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection
									title="Graph"
									testid="section-graph"
								>
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											write("graph", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "keyboard" && (
								<SettingsSection
									title="Keyboard"
									hint="Stored on this device"
									testid="section-keyboard"
								>
									<KeyboardSection />
								</SettingsSection>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}
