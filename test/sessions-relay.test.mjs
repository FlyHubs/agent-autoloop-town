// Tests the relay's own checks (sessions.mjs) against the ways an independent review (2026-11-16) found past them:
// a check at the start that a session named after the gate's mark could pass with no gate running; a message let
// through when the gate had stopped running; a message sent without leave whose answer isn't JSON; a check that
// fails for ever, a paid turn each time; a relay that turns out to have more tools; and what a Claude Code session the
// town was started from would pass on to the relay. Uses the stand-in for Claude Code (fake-claude.mjs): no network,
// no model, no money.
// Usage: node test/sessions-relay.test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionRelay } from "../sessions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(path.join(os.tmpdir(), "relay-check-"));
const inbox = path.join(base, "inbox");
mkdirSync(inbox);
const sent = path.join(base, "sent.jsonl");
writeFileSync(sent, "");
Object.assign(process.env, { FAKE_CLAUDE_LOG: sent, FAKE_CLAUDE_INBOX: inbox, CLAUDECODE: "1", CLAUDE_PID: "4242", CLAUDE_CODE_MESSAGING_TOKEN: "parent-secret", CLAUDE_CODE_SESSION_ID: "parent" });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (test, ms = 8000) => {
  for (const began = Date.now(); Date.now() - began < ms; await wait(50)) if (test()) return true;
  return false;
};
const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 600)}`}`);
const mode = (name) => (name ? writeFileSync(path.join(inbox, "mode.txt"), name) : rmSync(path.join(inbox, "mode.txt"), { force: true }));
const log = () => readFileSync(sent, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
let serial = 0;
/** A relay of its own, in a folder of its own, with what it says kept. */
function relay() {
  const folder = path.join(base, `relay-${++serial}`);
  const said = [];
  const made = sessionRelay({ program: path.join(here, "fake-claude.mjs"), folder, heard: () => {}, log: (words) => said.push(words), name: `测试传话${serial}`, waits: [50, 50, 50] });
  return { ...made, said, folder };
}
const peer = (from, text) => writeFileSync(path.join(inbox, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ from, text }));
const relays = [];

try {
  // As it should be: the gate runs, leaves its word, turns the check away; then lets the one message through.
  mode("");
  let one = relay();
  relays.push(one);
  await until(() => one.state() === "");
  const started = log().find((each) => each.started);
  check("a relay whose gate runs is ready after its check", one.state() === "", one.said);
  check("…it was started with nothing of the session the town was started from, its messages kept on this computer", started.inherited.length === 0 && started.traffic === "1" && started.started.includes("--permission-mode") && started.started[started.started.indexOf("--permission-mode") + 1] === "default", started);
  const settings = JSON.parse(readFileSync(path.join(one.folder, "relay-settings.json"), "utf8"));
  check("…and its gate stands before every tool", settings.hooks.PreToolUse[0].matcher === "*", settings.hooks.PreToolUse[0].matcher);
  const went = await one.send("主控", "一句话");
  check("…and what it is asked to send goes", went.sent === true, went);

  // The gate stops running after the check (hooks turned off while it runs): the next message let through shows it.
  mode("nohook");
  const after = await one.send("主控", "第二句");
  await until(() => one.state() !== "");
  check("a message let through without word from the gate stops the relay for good", one.said.some((words) => words.includes("没见关卡跑过")) && one.state() !== "", { said: one.said, after });
  one.stop();

  // No gate at all, and the check's send is answered by "a session" whose name carries the gate's mark.
  mode("spoof");
  one = relay();
  relays.push(one);
  await until(() => one.said.some((words) => words.includes("小时后再试")), 15_000);
  check("a check the gate's mark appears in without the gate having run is never passed: the relay rests instead", one.state() !== "" && !one.said.some((words) => words.includes("自检过了")), one.said);
  one.stop();

  // Claude Code itself refuses the check's call for being badly made, before any gate: a failed check, not a broken gate.
  mode("malformed");
  one = relay();
  relays.push(one);
  await until(() => log().filter((each) => each.malformed).length >= 1);
  await wait(300);
  check("a check refused by Claude Code for being badly made doesn't turn the relay off", !one.said.some((words) => words.includes("传话关掉了")), one.said);
  one.stop();

  // No network at first (the first three starts fall over at once): it goes on trying, and comes up when it can.
  mode("crashfirst");
  one = relay();
  relays.push(one);
  await until(() => one.state() === "", 15_000);
  check("a relay that can't start a few times (no network yet) comes up once it can, not turned off", one.state() === "" && !one.said.some((words) => words.includes("传话关掉了")), one.said);
  one.stop();

  // Two towns on one data folder: the second doesn't take the first's relay.
  mode("");
  let second = null;
  const first = relay();
  relays.push(first);
  try {
    second = sessionRelay({ program: path.join(here, "fake-claude.mjs"), folder: first.folder, heard: () => {}, log: () => {}, name: "第二个小镇", waits: [50, 50, 50] });
  } catch (error) {
    second = error;
  }
  check("a second town on the same data folder can't start its relay there", second instanceof Error && second.message.includes("另一个小镇"), String(second));
  if (!(second instanceof Error)) second?.stop();
  first.stop();

  // A message sent without leave whose answer is in plain words, not JSON.
  mode("");
  one = relay();
  relays.push(one);
  await until(() => one.state() === "");
  mode("textleak");
  peer("路人", "回我一句");
  await until(() => one.said.some((words) => words.includes("没经关卡放行就发出去了")));
  check("a message sent without leave is caught whatever form its answer takes", one.said.some((words) => words.includes("没经关卡放行就发出去了")) && one.state() !== "", one.said);
  one.stop();

  // The model won't make the check: three tries, then the relay stops, rather than paying for a turn for ever.
  mode("decline");
  one = relay();
  relays.push(one);
  await until(() => one.said.some((words) => words.includes("传话关掉了")), 15_000);
  const checks = log().filter((each) => each.started).length;
  check("a check that comes to nothing three times running stops the relay", one.said.some((words) => words.includes("自检连着三次没做成")) && one.state() !== "", one.said);
  await wait(400);
  check("…and it isn't started again after that", log().filter((each) => each.started).length === checks, { before: checks, after: log().filter((each) => each.started).length });
  one.stop();

  // It turns out to have a tool beyond the two.
  mode("extratool");
  one = relay();
  relays.push(one);
  await until(() => one.said.some((words) => words.includes("传话关掉了")));
  check("a relay that reports a tool beyond SendMessage and ListAgents is not used", one.said.some((words) => words.includes("还带着别的工具（Bash）")) && one.state() !== "", one.said);
  one.stop();

  // The gate itself: what it lets through, besides the one message, and what parameters it takes.
  mode("");
  const folder = path.join(base, "gate");
  mkdirSync(folder);
  const gate = path.join(here, "..", "session-gate.mjs");
  const ask = (tool, input) => JSON.parse(execFileSync(process.execPath, [gate, folder], { input: JSON.stringify({ tool_name: tool, tool_input: input }) }).toString()).hookSpecificOutput.permissionDecision;
  const leave = () => writeFileSync(path.join(folder, "gate.json"), JSON.stringify({ to: "主控", message: "原话", until: Date.now() + 60_000 }));
  writeFileSync(path.join(folder, "proof"), "word-for-this-start");
  check("the gate lets the relay list sessions", ask("ListAgents", {}) === "allow", null);
  check("…and nothing else but the one message", ask("Bash", { command: "ls" }) === "deny" && ask("Read", { file_path: "/etc/hosts" }) === "deny", null);
  leave();
  check("…which may carry no parameter it doesn't know, a summary of the model's own making among them", ask("SendMessage", { to: "主控", message: "原话", files: ["/etc/passwd"] }) === "deny" && ask("SendMessage", { to: "主控", message: "原话", summary: "一句" }) === "deny", null);
  check("…and goes with only those it does", ask("SendMessage", { to: "主控", message: "原话", type: "message" }) === "allow", null);
  check("…and each time it runs it leaves word that it ran", (() => { try { return readFileSync(path.join(folder, "heard"), "utf8"); } catch { return ""; } })() === "word-for-this-start", null);
} finally {
  for (const each of relays) each.stop();
  mode("");
  await wait(300);
  rmSync(base, { recursive: true, force: true });
}

const failed = results.some((line) => line.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(failed ? "\nSOME FAILED" : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
