/**
 * Runs once when the server starts (Next.js instrumentation hook).
 * Side-tutor fork, cloud sync Phase 1: in server mode with no password set,
 * print a fresh one-time setup code to the log (`docker compose logs lh`).
 * Phase 4: start Obsidian sync again if a vault is connected.
 * Outside server mode this does nothing.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.LH_SERVER_MODE !== "1") return;
	const { announceSetupCode } = await import("./src/server/server-auth.ts");
	announceSetupCode();
	const { obsidianSync } = await import("./src/server/obsidian-sync.ts");
	void obsidianSync().boot().catch((error: unknown) => console.error("[LearnHarness] Obsidian sync couldn't start:", error instanceof Error ? error.message : error));
}
