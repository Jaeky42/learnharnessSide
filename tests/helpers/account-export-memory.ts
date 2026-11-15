/** Child-process fixture for tests/account-export.test.ts: streams one export
 *  of `dataDir` into `outFile` and prints the most array-buffer memory the
 *  process RETAINED on the way. It collects before each reading, so the figure
 *  is what the writer holds, not garbage the collector hasn't reached yet;
 *  that needs `--expose-gc` at start-up (switching the flag on in a running
 *  process crashed the test file on Node 26). The caller sets the environment
 *  (server mode and a gate secret: the route only exists behind a gateway). */
import fs from "node:fs";
const [dataDir = "", outFile = ""] = process.argv.slice(2);
const collect = (globalThis as { gc?: () => void }).gc;
if (!collect || !dataDir || !outFile) {
	console.error("usage: node --expose-gc --import tsx account-export-memory.ts <dataDir> <outFile>");
	process.exit(2);
}
const { accountExportResponse } = await import("../../src/server/account-export.ts");
const response = await accountExportResponse(new Request("https://learn.example.com/api/account/export?name=sam"), { dataDir });
if (response.status !== 200 || !response.body) {
	console.error(`status ${response.status}`);
	process.exit(3);
}
const reader = response.body.getReader();
collect();
const baseline = process.memoryUsage().arrayBuffers;
let peak = 0;
let sinceReading = 0;
// The archive goes to disk, not memory, so the reading measures the writer.
const handle = fs.openSync(outFile, "w");
for (;;) {
	const { done, value } = await reader.read();
	if (done) break;
	fs.writeSync(handle, value);
	sinceReading += value.byteLength;
	if (sinceReading >= 4 * 1024 * 1024) {
		sinceReading = 0;
		collect();
		peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
	}
}
fs.closeSync(handle);
console.log(JSON.stringify({ peak }));
