import fs from "node:fs";
import { PATHS } from "../../config.ts";

/**
 * Side-tutor fork, the 0.6.0 merge: the Tutor's conversations moved into the
 * chat record (upstream's side conversations). The fork's old per-session
 * files in `<data>/side-tutor/` are no longer read by anything, and the owner
 * chose to delete them rather than convert them: once, at the first start of
 * the updated app, on the desktop and on the server. Copies inside a
 * first-sync backup are not touched.
 *
 * Safe to call at every start: after the first time there is nothing there.
 * Returns whether a folder was removed.
 */
export function removeOldSideTutorThreads(dir: string = PATHS.sideTutor): boolean {
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ dir)) return false;
		fs.rmSync(/* turbopackIgnore: true */ dir, { recursive: true, force: true });
		return true;
	} catch (error) {
		// Never stops the app from starting; the folder is only dead weight.
		console.error("[LearnHarness] The old side-tutor conversations couldn't be removed:", error instanceof Error ? error.message : error);
		return false;
	}
}
