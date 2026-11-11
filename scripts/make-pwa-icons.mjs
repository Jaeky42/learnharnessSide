// The website's icons (cloud sync Phase 3), rendered from the same design
// source as the desktop icons (build/icon-flat.svg):
//
//   app/favicon.ico                          the browser-tab icon (16, 32 and
//                                            48 px). Without it a browser
//                                            shows its own placeholder (a
//                                            globe in Chrome). Next serves it
//                                            at /favicon.ico and links it.
//   public/icons/icon-192.png, icon-512.png  the rounded icon as drawn
//   public/icons/maskable-512.png            full-bleed, for Android, which
//                                            cuts its own shape out of it
//   public/icons/apple-touch-icon.png        180×180 full-bleed, for iPhone,
//                                            which rounds the corners itself
//
// Full-bleed versions sit the design on the icon's own background colour
// (#141414) with the artwork scaled into Android's safe zone.
// Re-run after the design changes: `node scripts/make-pwa-icons.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");
const out = path.join(root, "public", "icons");
mkdirSync(out, { recursive: true });

const BACKGROUND = "#141414";
/** Android's maskable safe zone is the centre 80%; iPhone crops far less. */
const fullBleed = (scale) => {
	const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	const offset = (1024 * (1 - scale)) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${inner}</g></svg>`;
};
const render = (source, size) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();

const files = [
	["icon-192.png", render(svg, 192)],
	["icon-512.png", render(svg, 512)],
	["maskable-512.png", render(fullBleed(0.8), 512)],
	["apple-touch-icon.png", render(fullBleed(0.92), 180)],
];
for (const [name, png] of files) {
	writeFileSync(path.join(out, name), png);
	console.log(`public/icons/${name} — ${(png.length / 1024).toFixed(1)} KB`);
}

// ---- app/favicon.ico: ICONDIR + PNG entries (as scripts/make-icons.mjs) ----
const ICO_SIZES = [16, 32, 48];
const pngs = ICO_SIZES.map((size) => render(svg, size));
const header = Buffer.alloc(6 + ICO_SIZES.length * 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = header.length;
ICO_SIZES.forEach((size, i) => {
	const e = 6 + i * 16;
	header.writeUInt8(size, e);
	header.writeUInt8(size, e + 1);
	header.writeUInt8(0, e + 2); // colors
	header.writeUInt8(0, e + 3); // reserved
	header.writeUInt16LE(1, e + 4); // planes
	header.writeUInt16LE(32, e + 6); // bpp
	header.writeUInt32LE(pngs[i].length, e + 8);
	header.writeUInt32LE(offset, e + 12);
	offset += pngs[i].length;
});
const ico = Buffer.concat([header, ...pngs]);
writeFileSync(path.join(root, "app", "favicon.ico"), ico);
console.log(`app/favicon.ico — ${ICO_SIZES.join("/")}, ${(ico.length / 1024).toFixed(1)} KB`);
