/**
 * NOTES LIST DRAG PINS: the rules in components/notes/row-drag.ts
 * (owner-approved design). The dragged line follows the pointer, rows part
 * to open a gap, the middle of a folder lights that folder, and because
 * the list sorts itself a drag decides only which folder the item lands in.
 *
 * How the rows actually move on screen is checked in a real browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	aimDrag,
	clampLine,
	dropFolder,
	gapLevels,
	gapWhileOver,
	lineProbe,
	movedPath,
	planDrag,
	rowShifts,
	slotTop,
	type DragAim,
	type DragPlan,
	type DragRow,
} from "../components/notes/row-drag.ts";
import { canDropInto } from "../components/notes/notes-tree.tsx";

const H = 40;
/** Rows from their paths, 40 px each. A trailing "/" marks a folder. */
function rows(...paths: string[]): DragRow[] {
	return paths.map((raw, i) => {
		const folder = raw.endsWith("/");
		const path = folder ? raw.slice(0, -1) : raw;
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		return { path, folder, depth: parent ? parent.split("/").length : 0, parent, top: i * H, height: H };
	});
}
const plan = (list: DragRow[], path: string): DragPlan => {
	const p = planDrag(list, path);
	assert.ok(p, `${path} is in the list`);
	return p;
};

/** Follows the line's centre through `probes` the way the list does while a
 *  finger keeps moving (no pause on a folder): the rows are laid out for the
 *  last gap. Returns every aim. */
function follow(p: DragPlan, probes: number[], start?: DragAim): DragAim[] {
	const enter = (folder: string) => canDropInto(p.path, folder);
	let aim: DragAim = start ?? { gap: p.homeGap, level: p.home, over: null };
	const out: DragAim[] = [];
	for (const probe of probes) {
		aim = aimDrag(p, probe, aim.gap, aim, enter);
		out.push(aim);
	}
	return out;
}
const last = <T,>(list: T[]): T => list[list.length - 1]!;
const range = (from: number, to: number, step = 2): number[] => {
	const out: number[] = [];
	if (from <= to) for (let v = from; v <= to; v += step) out.push(v);
	else for (let v = from; v >= to; v -= step) out.push(v);
	return out;
};

// The owner's list: an open, empty Inbox; "yes" open with its notes; more below.
const OWNER = () => rows("Inbox/", "yes/", "yes/Electricity.md", "yes/Magnetism.md", "Physics/", "Circuits.md");

describe("the dragged block and the rest", () => {
	it("a note is lifted alone, and the rows below it close up", () => {
		const p = plan(OWNER(), "yes/Electricity.md");
		assert.deepEqual(p.block.map((r) => r.path), ["yes/Electricity.md"]);
		assert.equal(p.blockHeight, 40);
		assert.deepEqual(p.rest.map((r) => [r.path, r.top]), [["Inbox", 0], ["yes", 40], ["yes/Magnetism.md", 80], ["Physics", 120], ["Circuits.md", 160]]);
		assert.deepEqual(p.restStart, [0, 40, 120, 160, 200]);
		assert.equal(p.restHeight, 200);
		assert.equal(p.homeGap, 2);
		assert.deepEqual(p.home, { parent: "yes", depth: 1 });
	});

	it("a folder is lifted with everything shown in it, as one piece", () => {
		const p = plan(OWNER(), "yes");
		assert.deepEqual(p.block.map((r) => r.path), ["yes", "yes/Electricity.md", "yes/Magnetism.md"]);
		assert.equal(p.blockHeight, 120);
		assert.equal(p.headHeight, 40);
		assert.deepEqual(p.rest.map((r) => [r.path, r.top]), [["Inbox", 0], ["Physics", 40], ["Circuits.md", 80]]);
		assert.equal(p.homeGap, 1);
		// A folder named like the start of another isn't swept up with it.
		const q = plan(rows("yes/", "yes/A.md", "yes 2/", "yes 2/B.md"), "yes");
		assert.deepEqual(q.block.map((r) => r.path), ["yes", "yes/A.md"]);
	});

	it("isn't started for a row that isn't there", () => {
		assert.equal(planDrag(OWNER(), "Gone.md"), null);
	});
});

describe("rows part around the line", () => {
	const p = plan(OWNER(), "yes/Electricity.md");

	it("nothing has moved while the gap is where the item came from", () => {
		assert.deepEqual(rowShifts(p, p.homeGap), [0, 0, 0, 0, 0]);
		assert.equal(slotTop(p, p.homeGap), 80);
	});

	it("moving the gap up pushes the rows it passes down by one row", () => {
		assert.deepEqual(rowShifts(p, 1), [0, 40, 0, 0, 0]);
		assert.deepEqual(rowShifts(p, 0), [40, 40, 0, 0, 0]);
		assert.equal(slotTop(p, 0), 0);
	});

	it("moving it down pulls the rows it passes up", () => {
		assert.deepEqual(rowShifts(p, 4), [0, 0, -40, -40, 0]);
		assert.deepEqual(rowShifts(p, 5), [0, 0, -40, -40, -40]);
		assert.equal(slotTop(p, 5), 200);
	});
});

describe("where a drag lands", () => {
	it("the owner's case: a note dragged from its folder to above Inbox leaves every folder", () => {
		const p = plan(OWNER(), "yes/Electricity.md");
		// The line's centre starts at 100 and travels up to the very top.
		const path = follow(p, range(100, 4));
		const end = last(path);
		assert.deepEqual(end, { gap: 0, level: { parent: "", depth: 0 }, over: null });
		assert.equal(dropFolder(p, end), "");
		// On the way: it stays in its folder until it passes the folder's row…
		const stillHome = path.filter((a) => a.gap === 2);
		assert.ok(stillHome.length > 0 && stillHome.every((a) => a.level.parent === "yes" && dropFolder(p, a) === null));
		// …then the gap between Inbox and "yes" is outside every folder (Inbox
		// shows nothing under it, so the gap isn't inside Inbox)…
		const between = path.filter((a) => a.gap === 1 && a.over === null);
		assert.ok(between.length > 0 && between.every((a) => a.level.parent === ""));
		// …and Inbox's middle offers Inbox itself.
		assert.ok(path.some((a) => a.over === "Inbox"));
		assert.equal(dropFolder(p, path.find((a) => a.over === "Inbox")!), "Inbox");
	});

	it("put straight back, it stays where it was, also for an only note in its folder", () => {
		const p = plan(rows("Inbox/", "yes/", "yes/Electricity.md"), "yes/Electricity.md");
		for (const probe of [100, 96, 104, 88, 112, 81, 119]) {
			const aim = last(follow(p, [probe]));
			assert.equal(aim.gap, 2);
			assert.deepEqual(aim.level, { parent: "yes", depth: 1 }, `centre at ${probe}`);
			assert.equal(dropFolder(p, aim), null);
		}
		// Still over the lower half of its own folder's row: nothing changes.
		assert.equal(dropFolder(p, last(follow(p, range(100, 62)))), null);
	});

	it("a gap among a folder's notes is inside that folder; the line is indented like them", () => {
		const p = plan(OWNER(), "Circuits.md");
		// From the bottom up to between Electricity and Magnetism.
		const aim = last(follow(p, range(220, 122)));
		assert.equal(aim.gap, 3);
		assert.deepEqual(aim.level, { parent: "yes", depth: 1 });
		assert.equal(dropFolder(p, aim), "yes");
		assert.deepEqual(gapLevels(p, 3), [{ parent: "yes", depth: 1 }]);
		// Right under the open folder's own row, above its first note: inside it too.
		assert.deepEqual(gapLevels(p, 2), [{ parent: "yes", depth: 1 }]);
	});

	it("the middle of a folder means inside it; its top and bottom edges mean next to it", () => {
		const p = plan(OWNER(), "Circuits.md");
		// Physics is shown at 160-200 (the line starts right below it, at 200-240).
		// Its bottom quarter: the gap stays under it, where Circuits came from.
		const bottomEdge = last(follow(p, range(220, 192)));
		assert.deepEqual([bottomEdge.gap, bottomEdge.over], [5, null]);
		assert.equal(dropFolder(p, bottomEdge), null);
		const middle = last(follow(p, range(220, 180)));
		assert.equal(middle.over, "Physics");
		assert.equal(dropFolder(p, middle), "Physics");
		// Its top quarter: the gap opens above it.
		const topEdge = last(follow(p, range(220, 166)));
		assert.deepEqual([topEdge.gap, topEdge.over], [4, null]);
	});

	it("under a folder's last note the gap can mean that folder or the level outside it: the folder ahead first", () => {
		const p = plan(OWNER(), "Circuits.md");
		assert.deepEqual(gapLevels(p, 4), [{ parent: "yes", depth: 1 }, { parent: "", depth: 0 }]);
		// Coming up from below, past Physics: the folder ahead is "yes".
		const up = follow(p, range(220, 150));
		const entered = up.find((a) => a.gap === 4 && a.over === null)!;
		assert.equal(entered.level.parent, "yes");
		const inGap = last(up);
		assert.deepEqual([inGap.gap, inGap.level.parent], [4, "yes"]);
		assert.equal(dropFolder(p, inGap), "yes");
		// Turning back clearly towards Physics puts it outside again.
		const back = last(follow(p, range(150, 195, 1), inGap));
		assert.deepEqual([back.gap, back.level.parent], [4, ""]);
		assert.equal(dropFolder(p, back), null, "Circuits is already outside every folder");
		// A finger resting on the border between the two doesn't flip between them.
		const resting = follow(p, [179, 181, 179, 182, 178, 181], inGap).map((a) => a.level.parent);
		assert.deepEqual([...new Set(resting)], ["yes"]);
		const restingOut = follow(p, [181, 179, 182, 178, 181, 179], back).map((a) => a.level.parent);
		assert.deepEqual([...new Set(restingOut)], [""]);
	});

	it("coming down out of a folder past its last note, the level outside is ahead", () => {
		const p = plan(OWNER(), "yes/Electricity.md");
		// Electricity is the first note of "yes"; drag it down past Magnetism.
		const path = follow(p, range(100, 150));
		const out = last(path);
		assert.deepEqual([out.gap, out.level.parent], [3, ""]);
		assert.equal(dropFolder(p, out), "");
		// Turning back up puts it into "yes" again (no change).
		const back = last(follow(p, range(150, 126), out));
		assert.deepEqual([back.gap, back.level.parent], [3, "yes"]);
		assert.equal(dropFolder(p, back), null);
	});

	it("the item's own folder never lights for it, and a folder is never offered itself", () => {
		const p = plan(OWNER(), "yes/Electricity.md");
		assert.ok(follow(p, range(100, 42)).every((a) => a.over !== "yes"));
		const q = plan(OWNER(), "yes");
		assert.ok(follow(q, [...range(60, 0), ...range(0, 200)]).every((a) => a.over !== "yes" && !a.level.parent.startsWith("yes")));
	});

	it("a folder can be dropped into another folder or put back next to it", () => {
		const p = plan(OWNER(), "yes");
		// "yes" (120 px with its notes) starts at 40; its own row's centre is at 60.
		const onPhysics = last(follow(p, range(60, 182)));
		assert.equal(onPhysics.over, "Physics");
		assert.equal(dropFolder(p, onPhysics), "Physics");
		const home = last(follow(p, range(182, 60), onPhysics));
		assert.equal(dropFolder(p, home), null);
	});

	it("the bottom note of the bottom folder is pulled down and out of it (the owner's ask)", () => {
		// "yes" is the last folder and Magnetism its last note: the last row.
		const list = rows("Inbox/", "yes/", "yes/Electricity.md", "yes/Magnetism.md");
		const p = plan(list, "yes/Magnetism.md");
		assert.equal(p.homeGap, 3);
		// Its centre starts at 140. A small move down keeps it in its folder…
		const nudged = last(follow(p, range(140, 156)));
		assert.deepEqual([nudged.gap, nudged.level.parent], [3, "yes"]);
		assert.equal(dropFolder(p, nudged), null);
		// …half a row down takes it out of every folder.
		const out = last(follow(p, range(140, 162)));
		assert.deepEqual([out.gap, out.level], [3, { parent: "", depth: 0 }]);
		assert.equal(dropFolder(p, out), "");
		// The line has room for it: one row below the list's end.
		assert.equal(clampLine(p, 900, 0, 600), 160);
		// A finger resting right at that point doesn't flip it in and out.
		assert.deepEqual([...new Set(follow(p, [161, 158, 161, 157, 160, 156], out).map((a) => a.level.parent))], [""]);
		// Pulled clearly back up, it is in its folder again.
		const back = last(follow(p, range(162, 140), out));
		assert.equal(dropFolder(p, back), null);
	});

	it("the same for an only note, for a folder inside the last folder, and when the list can't show more room", () => {
		const only = plan(rows("Inbox/", "yes/", "yes/Electricity.md"), "yes/Electricity.md");
		assert.equal(dropFolder(only, last(follow(only, range(100, 122)))), "");
		// A folder with its notes, last in "yes": half of its own row is enough.
		const nested = plan(rows("yes/", "yes/A.md", "yes/sub/", "yes/sub/B.md"), "yes/sub");
		assert.equal(nested.blockHeight, 80);
		const pulled = last(follow(nested, range(100, 122)));
		assert.deepEqual([pulled.gap, pulled.level.parent], [2, ""]);
		assert.equal(dropFolder(nested, pulled), "");
		// The list ends at the bottom of what's visible, so the line can't move
		// lower; pulling on still moves the point the rules read to the line's
		// bottom edge, and that is enough.
		const held = clampLine(only, 500, 0, 120);
		assert.equal(held, 80);
		const probe = lineProbe(only, 500, held);
		assert.equal(probe, 120);
		assert.equal(dropFolder(only, aimDrag(only, probe, only.homeGap, null, () => true)), "");
	});

	it("from a folder inside a folder it steps out one folder at a time", () => {
		const p = plan(rows("yes/", "yes/sub/", "yes/sub/B.md"), "yes/sub/B.md");
		assert.deepEqual(gapLevels(p, p.homeGap).map((l) => l.parent), ["yes/sub", "yes", ""]);
		// Its centre starts at 100: half a row down is "yes", a little more is outside.
		assert.equal(last(follow(p, range(100, 118))).level.parent, "yes/sub");
		const one = last(follow(p, range(100, 122)));
		assert.deepEqual(one.level, { parent: "yes", depth: 1 });
		assert.equal(dropFolder(p, one), "yes");
		const two = last(follow(p, range(100, 136)));
		assert.deepEqual(two.level, { parent: "", depth: 0 });
		// Each step holds while the finger rests near its border.
		assert.deepEqual([...new Set(follow(p, [121, 118, 121, 117], one).map((a) => a.level.parent))], ["yes"]);
		assert.deepEqual([...new Set(follow(p, [131, 128, 131, 127], two).map((a) => a.level.parent))], [""]);
	});

	it("a note that is already outside every folder stays put when pulled below the list", () => {
		const p = plan(rows("yes/", "yes/A.md", "Loose.md"), "Loose.md");
		assert.equal(dropFolder(p, last(follow(p, range(100, 140)))), null);
	});

	it("below the last row is the end of the list, outside every folder", () => {
		const list = rows("yes/", "yes/A.md", "yes/B.md", "Loose.md");
		const p = plan(list, "yes/A.md");
		const end = last(follow(p, range(60, 150)));
		assert.deepEqual([end.gap, end.level.parent], [3, ""]);
	});
});

describe("a lit folder", () => {
	it("no gap stays open next to it: the rows go back to where they started", () => {
		// A note from "yes" comes down onto Physics: the gap was just above Physics (3).
		const q = plan(OWNER(), "yes/Electricity.md");
		assert.deepEqual(rowShifts(q, 3), [0, 0, -40, 0, 0], "Magnetism had moved up into the note's old place");
		assert.equal(gapWhileOver(q, "Physics", 3), q.homeGap);
		assert.deepEqual(rowShifts(q, gapWhileOver(q, "Physics", 3)), [0, 0, 0, 0, 0]);
		// A note from below comes up onto Physics: the gap was still its own old place.
		const p = plan(OWNER(), "Circuits.md");
		assert.equal(gapWhileOver(p, "Physics", 5), 5);
	});

	it("the folder itself never jumps away from under the line", () => {
		// The line passed Physics going up, then came back down onto it: Physics
		// had been pushed down, and going back to the start would move it.
		const p = plan(OWNER(), "Circuits.md");
		assert.equal(rowShifts(p, 4)[4], 40, "Physics, pushed down by the gap above it");
		assert.equal(gapWhileOver(p, "Physics", 4), 4);
	});

	it("the line reads the rows where they are shown while one is lit", () => {
		const p = plan(OWNER(), "Circuits.md");
		const enter = (folder: string) => canDropInto(p.path, folder);
		const over = last(follow(p, range(220, 180)));
		assert.equal(over.over, "Physics");
		// The folder is lit and the rows are at the start (gap 5).
		const shown = gapWhileOver(p, "Physics", over.gap);
		assert.equal(shown, 5);
		assert.equal(aimDrag(p, 178, shown, over, enter).over, "Physics");
		// Up onto its top edge: the gap opens above Physics.
		const edge = aimDrag(p, 166, shown, over, enter);
		assert.deepEqual([edge.gap, edge.over], [4, null]);
		// Back down into the item's own old place.
		const home = aimDrag(p, 215, shown, over, enter);
		assert.deepEqual([home.gap, home.over], [5, null]);
		assert.equal(dropFolder(p, home), null);
	});
});

describe("limits", () => {
	const p = plan(OWNER(), "yes/Electricity.md");

	it("the line can't go above the top of the list (on a phone, the divider under the heading)", () => {
		assert.equal(clampLine(p, -30, 0, 600), 0);
		// Scrolled 50 px: the visible top is the limit.
		assert.equal(clampLine(p, 10, 50, 600), 50);
	});

	it("nor below the visible bottom, or more than one row past the end of the list", () => {
		// The list is 240 px with the note in it; one more row of room below it.
		assert.equal(clampLine(p, 900, 0, 600), 240);
		assert.equal(clampLine(p, 900, 0, 150), 110);
		assert.equal(clampLine(p, 120, 0, 600), 120);
	});

	it("held back at the top, the line can still be pushed on: above the first row is reachable", () => {
		// Free to move: the point the rules read is the dragged row's centre.
		assert.equal(lineProbe(p, 120, 120), 140);
		// Held at the top (line top 0) with the finger 30 px further up: the
		// point moves on to the line's own top edge, and no further.
		assert.equal(lineProbe(p, -10, 0), 10);
		assert.equal(lineProbe(p, -30, 0), 0);
		assert.equal(lineProbe(p, -300, 0), 0);
		// So the top quarter of Inbox, the first row, is reached: a gap above it.
		const enter = (folder: string) => canDropInto(p.path, folder);
		const pressed = last(follow(p, [...range(100, 20), 12, 6, 0]));
		assert.deepEqual([pressed.gap, pressed.over, pressed.level.parent], [0, null, ""]);
		// Resting at the limit without pushing: the line covers Inbox, which lights.
		assert.equal(aimDrag(p, lineProbe(p, 0, 0), 1, null, enter).over, "Inbox");
		// The same at the bottom.
		assert.equal(lineProbe(p, 260, 200), 240);
	});

	it("a block taller than the visible part stays at its top", () => {
		const q = plan(OWNER(), "yes");
		assert.equal(clampLine(q, 80, 30, 100), 30);
	});
});

describe("after the drop", () => {
	it("knows the new paths of what moved, to slide the rows to their sorted places", () => {
		assert.equal(movedPath("yes/Electricity.md", "yes/Electricity.md", ""), "Electricity.md");
		assert.equal(movedPath("yes/Electricity.md", "yes/Electricity.md", "Physics"), "Physics/Electricity.md");
		assert.equal(movedPath("yes/Magnetism.md", "yes/Electricity.md", ""), "yes/Magnetism.md");
		// A folder takes everything in it along.
		assert.equal(movedPath("yes", "yes", "Physics"), "Physics/yes");
		assert.equal(movedPath("yes/sub/A.md", "yes", "Physics"), "Physics/yes/sub/A.md");
		assert.equal(movedPath("yes 2/B.md", "yes", "Physics"), "yes 2/B.md");
	});
});
