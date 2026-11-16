#!/usr/bin/env node
// A stand-in for Claude Code as the town's relay runs it (sessions.mjs): prompts as JSON lines on stdin, what happens
// as JSON lines on stdout, and the gate from --settings asked before each SendMessage, as Claude Code asks it. Nothing
// is sent anywhere: what the gate lets through is written to $FAKE_CLAUDE_LOG. A message from another session is
// made by putting { from, text, busy } as a .json file in $FAKE_CLAUDE_INBOX; this one then tries to answer it, as a
// model told not to might, and the gate is asked about that too. $FAKE_CLAUDE_INBOX/mode.txt, when there, says how
// things go: "missing" (no such session), "alter" (the model changes the words at first), "peerfirst" (a message from
// another session comes in just before each prompt), "nohook" (the gate is never asked, as when hooks don't run),
// "leak" (the gate is never asked, and what is sent goes), "spoof" (the gate is never asked, and a session's answer
// that it doesn't exist carries the gate's mark, as one named after the mark would), "textleak" (the gate is never
// asked, and what goes is said to have gone in plain words, not JSON), "decline" (the model won't make the check),
// "extratool" (it reports a tool beyond the two at its start), "malformed" (the check's call is refused by Claude Code
// for being badly made, before any gate), "crashfirst" (the first three starts fall over at once, as with no network).
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
const gate = settings.hooks.PreToolUse[0].hooks[0].command;
const inbox = process.env.FAKE_CLAUDE_INBOX;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
const mode = () => (existsSync(path.join(inbox, "mode.txt")) ? readFileSync(path.join(inbox, "mode.txt"), "utf8").trim() : "");
if (mode() === "crashfirst") {
  const count = path.join(inbox, "crashes.txt");
  const crashes = existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
  if (crashes < 3) {
    appendFileSync(count, "");
    writeFileSync(count, String(crashes + 1));
    process.exit(1);
  }
}
log({ started: args, simple: process.env.CLAUDE_CODE_SIMPLE ?? null, inherited: ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID"].filter((key) => process.env[key] !== undefined), traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null });
out({ type: "system", subtype: "init", tools: ["ListAgents", "SendMessage", ...(mode() === "extratool" ? ["Bash"] : [])], mcp_servers: [] });

let calls = 0;
/** Asks the gate, as Claude Code does, and does what it says. True when the message went. */
function sendMessage(to, message, extra = {}) {
  const id = `toolu_${++calls}`;
  const input = { to, message, ...extra };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "SendMessage", input }] } });
  const skipped = ["nohook", "leak", "spoof", "textleak", "malformed"].includes(mode());
  const decision = skipped ? { permissionDecision: "allow" } : JSON.parse(execSync(gate, { input: JSON.stringify({ tool_name: "SendMessage", tool_input: input }) }).toString()).hookSpecificOutput;
  if (decision.permissionDecision !== "allow") {
    log({ to, message, allowed: false, why: decision.permissionDecisionReason });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: decision.permissionDecisionReason }] } });
    return false;
  }
  if (mode() === "malformed" && to === "小镇自检") {
    log({ to, message, allowed: false, malformed: true });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "<tool_use_error>InputValidationError: SendMessage failed due to the following issue: missing parameter</tool_use_error>" }] } });
    return false;
  }
  if (mode() === "spoof" && to === "小镇自检") {
    log({ to, message, allowed: true, skipped });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "Error: No agent named '小镇关卡：自检' is reachable." }] } });
    return false;
  }
  const reachable = mode() !== "missing" && to !== "小镇自检" && (mode() !== "nohook" || to !== "小镇自检");
  if (mode() === "textleak" && reachable) {
    log({ to, message, allowed: true, skipped });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `Message sent to ${to}.` }] } });
    return true;
  }
  if (reachable) log({ to, message, allowed: true, skipped });
  const result = reachable ? { success: true, message: `→ ${to}` } : { success: false, message: `No agent named '${to}' is reachable.` };
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify(result) }] }] } });
  return result.success;
}

/** A message from another session, as Claude Code hands it on; and the model trying to answer it. */
function incoming({ from, text, busy }) {
  out({ type: "user", isReplay: true, message: { role: "user", content: `${busy ? "Another Claude session sent a message while you were working:" : "Another Claude session sent a message:"}\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${from}" from-mode="prompting">\n${text}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.` } });
  sendMessage(from, "收");
  out({ type: "result", result: "收" });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
    const prompt = JSON.parse(buffer.slice(0, at)).message.content;
    buffer = buffer.slice(at + 1);
    if (mode() === "peerfirst") incoming({ from: "路人", text: "插一句" });
    out({ type: "user", isReplay: true, message: { role: "user", content: prompt } });
    if (prompt.includes("小镇自检")) {
      if (mode() !== "decline") sendMessage("小镇自检", "自检");
      out({ type: "result", result: "好" });
      continue;
    }
    const to = /\nto：(.+)\n/.exec(prompt)?.[1];
    const message = /\n<<<\n([\s\S]*)\n>>>$/.exec(prompt)?.[1];
    let went = sendMessage(to, mode() === "alter" ? `${message}。` : message);
    // Turned away, it tries again as told: with the words as given.
    if (!went && mode() === "alter") went = sendMessage(to, message);
    out({ type: "assistant", message: { content: [{ type: "text", text: went ? "已发" : "没发成" }] } });
    out({ type: "result", result: went ? "已发" : "没发成" });
  }
});
process.stdin.on("end", () => process.exit(0));

setInterval(() => {
  for (const name of readdirSync(inbox).filter((each) => each.endsWith(".json")).sort()) {
    const message = JSON.parse(readFileSync(path.join(inbox, name), "utf8"));
    rmSync(path.join(inbox, name));
    incoming(message);
  }
}, 100);
