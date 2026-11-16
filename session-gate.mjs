#!/usr/bin/env node
// The gate in front of the town's relay (sessions.mjs): Claude Code runs this before each SendMessage the relay makes,
// and does what it says. A message goes out only when it is the very one the town has just asked for, word for word,
// to the very session it named, and only once: the model in between can't change what is said, say it to someone
// else, or answer a session that wrote to it. Anything else is turned away with a reason the model reads.
// It turns away whatever it can't make sense of. Claude Code lets a call through when a gate fails to run at all: the
// relay is started so that a gate that fails says no all the same, and checks at the start that its no is heard.
// It also leaves word that it ran: the town doesn't take a no, or a message let through, for the gate's unless it has.
// Usage (from the settings the relay is started with): node session-gate.mjs <folder holding gate.json>
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Every no starts with this: the relay's check at the start looks for it.
const MARK = "小镇关卡：";
let decided = false;
const decide = (decision, reason) => {
  if (decided) return;
  decided = true;
  // Out through a pipe, which on some systems is written later: the process ends once it has been.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: decision === "allow" ? reason : MARK + reason } }), () => process.exit(0));
};

/** Word that the gate ran: the word made for this start of the relay, copied where the town looks for it. */
function proveRun(folder) {
  try {
    // Whole or not at all: written aside, then moved into place, so the town never reads it half written.
    const aside = path.join(folder, `heard.${process.pid}`);
    writeFileSync(aside, readFileSync(path.join(folder, "proof")), { mode: 0o600 });
    renameSync(aside, path.join(folder, "heard"));
  } catch {
    // Without its word the town takes the gate as not having run, which is the safe way to be wrong.
  }
}

// What a SendMessage may say: whom to, what, and that it is a plain message. Nothing else (no summary of the model's
// own making to go with the owner's words, no asking to be told when the session is idle).
const KNOWN = new Set(["to", "message", "type"]);

function judge(given, folder) {
  proveRun(folder);
  const call = JSON.parse(given);
  // Listing the sessions is all the relay may do besides sending the one message.
  if (call?.tool_name === "ListAgents") return decide("allow", "列出会话");
  if (call?.tool_name !== "SendMessage") return decide("deny", "这里只发小镇交代的那一条消息");
  const file = path.join(folder, "gate.json");
  let wanted;
  try {
    wanted = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return decide("deny", "小镇现在没让你发任何消息：不要发，也不要回复别的会话");
  }
  if (typeof wanted?.to !== "string" || typeof wanted.message !== "string") return decide("deny", "小镇交代的那一条看不懂");
  // A permission left lying about from a turn that went wrong is no permission.
  if (!(Date.now() < wanted.until)) return (rmSync(file, { force: true }), decide("deny", "小镇交代的那一条已经过时了"));
  const input = call.tool_input;
  if (!input || typeof input !== "object") return decide("deny", "看不懂这次调用");
  const unknown = Object.keys(input).filter((key) => !KNOWN.has(key));
  if (unknown.length) return decide("deny", `只带 to 和 message：不要带 ${unknown.slice(0, 3).join("、")}`);
  if (input.to !== wanted.to) return decide("deny", `只能发给「${wanted.to}」`);
  if (input.message !== wanted.message) return decide("deny", "message 要和小镇给的文字一字不差：照原文再发一次");
  if ((input.type ?? "message") !== "message") return decide("deny", "只发一条普通消息");
  // Once: of two asking at the same time, the one that takes it away first is the one let through.
  try {
    renameSync(file, `${file}.${process.pid}`);
  } catch {
    return decide("deny", "小镇交代的那一条已经发过了");
  }
  rmSync(`${file}.${process.pid}`, { force: true });
  return decide("allow", "小镇交代的那一条");
}

let given = "";
process.stdin.on("data", (chunk) => (given += chunk));
process.stdin.on("end", () => {
  try {
    judge(given, process.argv[2]);
  } catch {
    decide("deny", "出错了，不放行");
  }
});
