// Opens a page in headless Chromium over the DevTools protocol, waits in real time, reports what the page logged and
// what a probe expression returns, and saves a screenshot. Usage: node shot.mjs <url> <png> <seconds> [width] [height] [dark]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [url, png, seconds = "6", width = "1480", height = "980", dark = ""] = process.argv.slice(2);
// Any Chromium that takes --remote-debugging-port will do: TOWN_CHROME names one. Without it, the newest headless
// shell Playwright has downloaded on this machine is used, if there is one.
function chromium() {
  if (process.env.TOWN_CHROME) return process.env.TOWN_CHROME;
  const cache = process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
  const builds = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const build of builds) {
    for (const folder of readdirSync(join(cache, build))) {
      const program = join(cache, build, folder, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (existsSync(program)) return program;
    }
  }
  console.error("找不到无头 Chromium：用环境变量 TOWN_CHROME 指定一个，或者先运行 npx playwright install chromium-headless-shell");
  process.exit(1);
}
const shell = chromium();
const profile = mkdtempSync(join(tmpdir(), "town-shot-"));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(shell, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", ...(process.env.FLAGS ? process.env.FLAGS.split(" ") : []), "about:blank"], { stdio: "ignore" });
try {
  let target;
  for (let tries = 0; tries < 50 && !target; tries++) {
    await delay(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((each) => each.type === "page"); } catch {}
  }
  if (!target) throw new Error("browser did not start");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const waiting = new Map();
  const logs = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) (waiting.get(message.id)(message), waiting.delete(message.id));
    if (message.method === "Runtime.consoleAPICalled") logs.push(`console.${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
    if (message.method === "Runtime.exceptionThrown") logs.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    if (message.method === "Log.entryAdded") logs.push(`log.${message.params.entry.level}: ${message.params.entry.text}`);
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
  if (dark) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.navigate", { url });
  await delay(Number(seconds) * 1000);
  const probe = process.env.PROBE ?? `JSON.stringify({ banner: document.getElementById("banner")?.hidden === false ? document.getElementById("banner").textContent : null, conn: document.getElementById("conn")?.textContent, buildings: document.querySelectorAll(".bld").length, signs: document.querySelectorAll(".sign").length, busy: document.querySelectorAll(".bld.busy").length, feedRows: document.querySelectorAll("#feed .row").length, cards: document.querySelectorAll("#cards .card").length, tiles: [...document.querySelectorAll(".tile")].map((tile) => tile.querySelector(".label").textContent + "=" + tile.querySelector(".value").textContent) })`;
  const probed = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
  console.log("probe:", probed.result?.result?.value ?? JSON.stringify(probed.result));
  if (process.env.AFTER) { await send("Runtime.evaluate", { expression: process.env.AFTER, awaitPromise: true }); await delay(Number(process.env.AFTER_WAIT ?? 1) * 1000); }
  if (process.env.PROBE2) { const second = await send("Runtime.evaluate", { expression: process.env.PROBE2, awaitPromise: true, returnByValue: true }); console.log("probe2:", second.result?.result?.value ?? JSON.stringify(second.result)); }
  // SERIES="2,5,9": more pictures, that many seconds after this point, saved beside the last as <name>-1.png, -2.png, …;
  // SERIES_PROBE is asked before each and printed. For looking at something as it goes on.
  const series = (process.env.SERIES ?? "").split(",").map(Number).filter((each) => each >= 0);
  const began = Date.now();
  for (const [index, at] of series.entries()) {
    await delay(Math.max(0, at * 1000 - (Date.now() - began)));
    if (process.env.SERIES_PROBE) { const said = await send("Runtime.evaluate", { expression: process.env.SERIES_PROBE, awaitPromise: true, returnByValue: true }); console.log(`at ${at}s:`, said.result?.result?.value ?? JSON.stringify(said.result)); }
    const frame = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(png.replace(/\.png$/, `-${index + 1}.png`), Buffer.from(frame.result.data, "base64"));
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(png, Buffer.from(shot.result.data, "base64"));
  console.log(logs.length ? logs.join("\n") : "no console errors or logs");
  socket.close();
} finally {
  browser.kill("SIGKILL");
  await delay(300);
  rmSync(profile, { recursive: true, force: true });
}
