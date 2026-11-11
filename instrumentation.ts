/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice.
 *
 * Side-tutor fork, cloud sync Phase 1: in server mode with no password set,
 * print a fresh one-time setup code to the log (`docker compose logs lh`).
 * Phase 4: start Obsidian sync again if a vault is connected.
 * Outside server mode the fork's part does nothing. It runs after the
 * plugins, and a plugin failure never stops it.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	try {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		await initializePlugins();
	} catch (error) {
		console.error("[plugins] Initialization failed; plugin management will report the error:", error);
	}
	if (process.env.LH_SERVER_MODE !== "1") return;
	const { announceSetupCode } = await import("./src/server/server-auth.ts");
	announceSetupCode();
	const { obsidianSync } = await import("./src/server/obsidian-sync.ts");
	void obsidianSync().boot().catch((error: unknown) => console.error("[LearnHarness] Obsidian sync couldn't start:", error instanceof Error ? error.message : error));
}
