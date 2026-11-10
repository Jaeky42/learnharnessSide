/**
 * Runs once when the server starts (Next.js instrumentation hook).
 * Side-tutor fork, cloud sync Phase 1: in server mode with no password set,
 * print a fresh one-time setup code to the log (`docker compose logs lh`).
 * Outside server mode this does nothing.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.LH_SERVER_MODE !== "1") return;
	const { announceSetupCode } = await import("./src/server/server-auth.ts");
	announceSetupCode();
}
