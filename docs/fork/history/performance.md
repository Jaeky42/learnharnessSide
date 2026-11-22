# History and records: Long sessions: the performance audit and what was built from it

## The off-screen rule

**Jumps into a message that isn't drawn:**

- **Checked by a second analyst** (950 messages, a computer and iPhone size, rule on against off): Find 14 of 14 forward and backward, also stepping fast and typing a new search during a settle; the Tutor's quotes 3 of 3 from the bottom and from the top; links to a message at 16–17 px; no attribute left behind; opening at the bottom in 80 of 80 loads; a streamed reply followed the same on and off; with the rule off everything as before the fix. A citation jump wasn't run (the data has none).

## Measured

Workers' own measurements on the test library (Node, not a browser):

| | before | after |
|---|---|---|
| One stale-job sweep | 1.2–1.8 s | 2–5 ms |
| Session files parsed per sweep | 68 | 0 |
| `listChats`, second call | 148 ms | 0.1 ms |
| Full session download, 950 messages | 3,568,720 B | 2,716,523 B |
| Active-problem scan, one render's worth, 950 messages | 113–145 ms | 2 ms, then 0.1 ms |
| The same at 2,850 messages | 1,141–1,218 ms | 11 ms, then 0.1 ms |
| `computeBacklinks`, 1,000 notes × 4 links | about 1 s | 11 ms |

In a browser, after the build (headless Chromium, software rendering, a production build, 950 messages; medians of 3 where repeated; machine noise about ±30%, and the "before" column is the audit's, taken on a busier machine). "Off" is step 1 alone (`?offscreen=off`), "on" adds the off-screen rule as first built (a flat 600 px estimate). That switch has since been removed; to compare with the rule off now, see "No switch" under "The off-screen rule" in `docs/fork/performance.md`.

| | before | off | on |
|---|---|---|---|
| Open: until the page reacts | 13.6–18 s | 12.4 s | 8.3 s |
| Open at 4× | 28.6 s | 37.5 s | 29.3 s |
| Full-record downloads at open; page size | 2–3; 7.1 MB | 0; 6.27 MB | 0; 6.27 MB |
| 60 wheel steps: main thread / hit-testing | 1.71 / 0.86 s | 2.0 / 1.04 s | 1.2–1.3 / 0.06 s |
| The same at 4× | 14.7–21.5 / 4.2–4.7 s | 8.5 / 4.3 s | 5.3–5.7 / 0.3 s |
| At 4×: frames over 50 ms / worst frame | 72–79 / 4.3–4.5 s | 59–61 / 183–217 ms | 27–29 / 150–217 ms |
| Six touch swipes, frames over 33 ms | 11–13 | 9–20 | 1–4 |
| One re-render with nothing changed (4×) | about 300 ms (1.2 s) | 91 ms (528 ms) | 80 ms (477 ms) |
| One streamed update, main thread | 410 ms | 125 ms | 102 ms |
| Idle on a paired device, 45 s: freezes | 4 of 0.28–0.43 s (4×: 1.2–2.4 s) | 0 | 0 |
| Reconnect on a paired device | 3.57 MB, 0.9–1.0 s of long tasks | 90 B, 0.46–0.52 s | the same |
| Full session download: server time | about 115 ms | 78 ms | |

- **Step 1 alone** removes the multi-second scroll frames, the idle freezes and the download on return, and cuts a re-render about threefold. It does not make opening faster: at 4× the difference from the audit is within noise.
- **The off-screen rule** is what speeds up opening (style recalculation 2.16 s → 0.83 s) and ordinary scrolling (hit-testing down 94%). It adds layout, pre-paint and IntersectionObserver work while scrolling (layout at 4×: 58 → 481 ms per 60 steps) and two style recalculations a second at idle (20–250 ms per 45 s).
- **Not changed by either:** the one hydration task at opening (14–16 s at 4×), and a lesson of 95 messages (no gain).
- `?only=stamp` costs the server about half a full read (38 ms against 78 ms at 950 messages): it parses the file once.
- **With the per-kind estimates and the jump fix** (a second analyst's runs, another day's machine load, so compare on with off, not with the table): opening 6.9 s on against 8.3 s off; 60 wheel steps at 4×: main thread 3.2 s against 4.7–5.8 s, hit-testing 0.13 s against 2.4–3.1 s. A Find step takes about 520 ms on against 490 ms off.
- No run of the new build at 2,850 messages, and none with a real model.
