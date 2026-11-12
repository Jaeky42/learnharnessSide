/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice.
 *
 * Side-tutor fork, cloud sync Phase 1: in server mode with no password set,
 * print a fresh one-time setup code to the log (`docker compose logs lh`).
 * Phase 4: start Obsidian sync again if a vault is connected.
 * Everywhere: the old side-tutor conversation files are removed (the Tutor's
 * conversations live in the chat record since the 0.6.0 merge).
 * The fork's part runs after the plugins, and a plugin failure never stops it.
 * One part runs before them: on the server, the time zone a paired desktop
 * gave for Flashcards sync (decision S2), so the plugin works out its study
 * days in it from the start. Nothing is set where no desktop ever gave one.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	if (process.env.LH_SERVER_MODE === "1") {
		try {
			const { applyStoredTimeZone } = await import("./src/server/sync/flashcards-zone.ts");
			applyStoredTimeZone();
		} catch (error) {
			console.error("[LearnHarness] Flashcards sync: the saved time zone couldn't be used:", error instanceof Error ? error.message : error);
		}
	}
	try {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		await initializePlugins();
	} catch (error) {
		console.error("[plugins] Initialization failed; plugin management will report the error:", error);
	}
	// Side-tutor fork: the Tutor's old conversation files went with its engine.
	const { removeOldSideTutorThreads } = await import("./src/server/side-tutor-cleanup.ts");
	removeOldSideTutorThreads();
	if (process.env.LH_SERVER_MODE !== "1") return;
	const { announceSetupCode } = await import("./src/server/server-auth.ts");
	announceSetupCode();
	const { obsidianSync } = await import("./src/server/obsidian-sync.ts");
	void obsidianSync().boot().catch((error: unknown) => console.error("[LearnHarness] Obsidian sync couldn't start:", error instanceof Error ? error.message : error));
}
