// Engine worker of the sealed box. Everything it needs arrives as bytes;
// nothing here may reach the network.
import { loadPyodide } from "pyodide/pyodide.mjs";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import { loadMicroPython } from "./micropython.patched.mjs";
import initSqlJs from "sql.js/dist/sql-wasm.js";

const realFetch = typeof self.fetch === "function" ? self.fetch.bind(self) : null;
const files = new Map();
self.fetch = async (input) => {
  const url = String(input && input.url ? input.url : input);
  const name = url.split("?")[0].split("/").pop();
  if (!files.has(name)) throw new TypeError("sealed box: no network (" + name + ")");
  const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return new Response(files.get(name), { status: 200, headers: { "content-type": type } });
};

const now = () => performance.now();
let py = null, mpy = null, SQL = null, out = [];
const print = (s) => { if (out.length < 400) out.push(String(s)); };

async function blocked(fn) {
  try { await fn(); return "REACHED"; } catch (e) { return "blocked"; }
}

const ops = {
  async probe() {
    const r = {};
    r.wasm = await (async () => { try { await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return "ok"; } catch (e) { return "FAILED: " + e.message; } })();
    r.fetchOther = realFetch ? await blocked(() => realFetch("https://example.com/", { mode: "no-cors" })) : "blocked";
    r.xhr = await blocked(() => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "https://example.com/"); x.onload = ok; x.onerror = no; x.send(); }));
    r.socket = await blocked(() => new Promise((ok, no) => { const w = new WebSocket("wss://example.com/"); w.onopen = ok; w.onerror = no; setTimeout(no, 1500); }));
    r.indexedDB = await blocked(() => new Promise((ok, no) => { const q = indexedDB.open("x"); q.onsuccess = ok; q.onerror = no; }));
    r.origin = String(self.origin);
    return r;
  },
  async sql({ wasm, setup, query }) {
    const t0 = now();
    if (!SQL) SQL = await initSqlJs({ wasmBinary: wasm });
    const boot = now() - t0;
    const t1 = now();
    const db = new SQL.Database();
    db.run(setup);
    const res = db.exec(query);
    db.close();
    return { bootMs: boot, runMs: now() - t1, columns: res[0] ? res[0].columns : [], rows: res[0] ? res[0].values : [] };
  },
  async mpyBoot({ wasm }) {
    files.set("micropython.wasm", wasm);
    const t0 = now();
    mpy = await loadMicroPython({ url: "https://sealed.invalid/micropython.wasm", heapsize: 16 * 1024 * 1024, stdout: print, stderr: print });
    files.delete("micropython.wasm");
    return { bootMs: now() - t0 };
  },
  async mpyRun({ code }) {
    out = [];
    const t0 = now();
    let error = null;
    try { mpy.runPython(code); } catch (e) { error = String(e && e.message ? e.message : e).slice(0, 600); }
    return { runMs: now() - t0, out: out.join("\n"), error };
  },
  async pyBoot({ wasm, stdlib, lock }) {
    files.set("pyodide.asm.wasm", wasm);
    files.set("python_stdlib.zip", stdlib);
    const t0 = now();
    py = await loadPyodide({
      indexURL: "https://sealed.invalid/py/",
      lockFileContents: JSON.parse(new TextDecoder().decode(lock)),
      packageBaseUrl: "https://sealed.invalid/py/",
      createPyodideModule,
      stdout: print,
      stderr: print,
    });
    files.clear();
    return { bootMs: now() - t0, version: py.version };
  },
  async pyRun({ code }) {
    out = [];
    const t0 = now();
    let error = null;
    try { await py.runPythonAsync(code); } catch (e) { error = String(e && e.message ? e.message : e).slice(-600); }
    return { runMs: now() - t0, out: out.join("\n"), error };
  },
  async spin() { for (;;) {} },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await ops[op](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 800) });
  }
};
self.postMessage({ ready: true });
