/**
 * SIDE TUTOR INSTALL FOLDER PIN.
 *
 * A one-click, per-user NSIS install names its folder after package.json
 * "name" (app-builder-lib getWindowsInstallationDirName), not productName.
 * The side tutor shipped with the official name once: both apps landed in
 * %LOCALAPPDATA%\Programs\learnharness and the side tutor overwrote the
 * official app's files. This pins a distinct package name for the side
 * tutor build so that can't happen again — and pins the side tutor's own
 * update feed (the fork's releases), never the official one.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = require("js-yaml") as { load(source: string): any };

describe("side tutor installer", () => {
	const side = yaml.load(fs.readFileSync(path.join(repoRoot, "electron-builder.side-tutor.yml"), "utf8"));
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

	it("gets its own package name, so it installs to its own folder", () => {
		const name = side?.extraMetadata?.name;
		assert.equal(typeof name, "string");
		assert.notEqual(name, pkg.name);
		assert.match(name, /^[a-z0-9-]+$/);
	});

	it("is still a one-click per-user install (the case where the package name decides the folder)", () => {
		assert.equal(side?.nsis?.oneClick, true);
		assert.equal(side?.nsis?.perMachine, false);
	});

	it("keeps its own app id and executable", () => {
		const official = yaml.load(fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8"));
		assert.notEqual(side.appId, official.appId);
		assert.equal(side.win?.executableName, "LearnHarnessSideTutor");
	});

	it("updates from the fork's own releases, as an object that replaces the official feed", () => {
		// electron-builder's `extends` merge concatenates arrays: a LIST here
		// would keep the official feed first. An object replaces it.
		assert.ok(side.publish && typeof side.publish === "object" && !Array.isArray(side.publish));
		assert.equal(side.publish.provider, "github");
		assert.equal(side.publish.owner, "Jaeky42");
		assert.equal(side.publish.repo, "learnharnessSide");
		assert.equal(side.publish.releaseType, "release");
		assert.notEqual(side.extraMetadata?.lhAutoUpdate, false);
		assert.equal(side.win?.verifyUpdateCodeSignature, false);
	});

	it("never deletes the shared data folder on uninstall", () => {
		assert.equal(side?.nsis?.deleteAppDataOnUninstall, false);
	});
});
