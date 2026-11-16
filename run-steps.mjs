// What an Agent did in a round, as a few words a step: "读 auth.log", "改 login.ts", "跑 npm", and at the end the
// round's own conclusion. The town shows them beside the Agent while it works. They are read from what the worker on
// this computer keeps of each round (<home>/worker/runs/<round>-<try>/stdout-<turn>.log): Claude Code's or Codex's own
// output, a JSON line for each thing said and each tool used.
//
// A step never says more than a file's name, a program's name, the words of a web search, or the Agent's own short
// words about what it is doing: not what was read or written, not what a command printed, not a command's arguments or
// settings, not what was searched for in files, not a folder. The Agent's own words may of course quote what it saw.
// The record may hold anything, a key included; the page is the owner's own, but what is on a screen is seen by
// whoever is in the room.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, constants as FS } from "node:fs";
import path from "node:path";

const MOST = 40; // steps kept: the latest
const LONG = 64; // letters in a step
const TAIL = 2 * 1024 * 1024; // how much of a record's end is read
const LINES = 5000; // and of that, how many lines at most

/** Text, or nothing: a value of any other kind in a record is taken as nothing. */
const textOf = (value) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
/** One line, with nothing in it that breaks a line or turns text around, and no longer than `most` letters. */
function plain(text, most = LONG) {
  // Cut long before it is cleaned: a description of a megabyte is not to be gone through letter by letter.
  const letters = [...textOf(text).slice(0, most * 4).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim()];
  return letters.length > most ? `${letters.slice(0, most - 1).join("")}…` : letters.join("");
}
/** The first line of some words that has anything in it. */
const firstLine = (text) => textOf(text).split(/\r\n|[\n\r\u0085\u2028\u2029]/).find((line) => line.trim()) ?? "";
/** A file's name without its folders. */
const nameOf = (file) => (typeof file === "string" && file ? plain(file.replace(/[\\/]+$/, "").split(/[\\/]/).pop(), 40) : "");
/** The program a command line starts: past any shell it is wrapped in and any settings put before it, without its folder. */
function programOf(command) {
  if (typeof command !== "string") return "";
  let line = command.trim();
  // bash -lc '…', zsh -c "…", sh -c …: what matters is what the shell is told to run.
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(['"]?)([\s\S]*)$/.exec(line);
  if (wrapped) line = wrapped[2].replace(/^['"]/, "");
  // A setting's quoted value is no word of the command (TOKEN="Bearer …" curl): it goes, to the closing quote or the end.
  line = line.replace(/=(["'])[\s\S]*?(?:\1|$)/g, "=");
  const words = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const word = words.find((each) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(each)) ?? "";
  return plain(word.replace(/^['"]+|['"]+$/g, "").split(/[\\/]/).pop().replace(/[^\w.+-]/g, ""), 24);
}
const step = (kind, words, id) => ({ kind, words: plain(words), ok: true, ...(id && { id }) });

/** The step one of Claude Code's tools makes, or none for those that say nothing of the work. */
function claudeTool(name, input, id) {
  const given = input && typeof input === "object" ? input : {};
  const file = nameOf(given.file_path ?? given.notebook_path ?? given.path);
  if (name === "Read") return step("read", file ? `读 ${file}` : "读文件", id);
  if (name === "Write") return step("edit", file ? `写 ${file}` : "写文件", id);
  if (["Edit", "MultiEdit", "NotebookEdit"].includes(name)) return step("edit", file ? `改 ${file}` : "改文件", id);
  if (name === "Bash") {
    // What it says it is doing, in its own few words; else only which program it runs.
    const about = plain(given.description, 48);
    const program = programOf(given.command);
    return step("run", about ? `跑：${about}` : program ? `跑 ${program}` : "跑命令", id);
  }
  // What is searched for in files may be a key or an address, and a pattern may be a folder: only a file pattern's name.
  if (name === "Grep") return step("find", "找内容", id);
  if (name === "Glob") return step("find", nameOf(given.pattern) ? `找 ${nameOf(given.pattern)}` : "找文件", id);
  if (name === "WebSearch") return step("web", given.query ? `搜：${plain(given.query, 40)}` : "上网搜", id);
  if (name === "WebFetch") {
    let host = "";
    try {
      host = new URL(given.url).hostname;
    } catch {
      // Not an address: nothing to name.
    }
    return step("web", host ? `看网页 ${plain(host, 40)}` : "看网页", id);
  }
  if (name === "Task" || name === "Agent") return step("tool", given.description ? `派给子 Agent：${plain(given.description, 40)}` : "派给子 Agent", id);
  if (name === "SendMessage") return step("tool", given.to ? `给会话「${plain(given.to, 24)}」发消息` : "给别的会话发消息", id);
  if (["TodoWrite", "ToolSearch", "ExitPlanMode", "EnterPlanMode"].includes(name)) return null;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return step("tool", mcp ? `用 ${plain(mcp[1], 20)} 的 ${plain(mcp[2], 30)}` : `用 ${plain(name, 40)}`, id);
}

/** The steps in a record: Claude Code's stream of JSON lines, or Codex's. Lines that are neither are passed over. */
export function stepsIn(text) {
  const steps = [];
  const byId = new Map();
  const add = (made) => {
    if (!made?.words) return;
    steps.push(made);
    if (made.id) byId.set(made.id, made);
  };
  /** The round's own last words become its conclusion: said once, as the ending. */
  const conclude = (kind, words) => {
    const line = plain(firstLine(words));
    if (!line) return;
    if (steps.at(-1)?.kind === "say" && steps.at(-1).words === line) steps.pop();
    add({ kind, words: line, ok: kind === "done" });
  };
  // Only what looks like a JSON object is tried, and only the latest lines: a record full of other text that happens
  // to start with a brace would otherwise cost a failed parse a line, all of it while the town waits.
  for (const whole of String(text).split("\n").slice(-LINES)) {
    const row = whole.trimEnd();
    if (row.length < 2 || !row.startsWith('{"') || !row.endsWith("}")) continue;
    let line;
    try {
      line = JSON.parse(row);
    } catch {
      continue;
    }
    if (!line || typeof line !== "object") continue;
    // ---- Claude Code
    if (line.type === "assistant" && Array.isArray(line.message?.content)) {
      for (const part of line.message.content) {
        if (part?.type === "tool_use" && typeof part.name === "string") add(claudeTool(part.name, part.input, part.id));
        else if (part?.type === "text") add(step("say", firstLine(part.text)));
      }
    } else if (line.type === "user" && Array.isArray(line.message?.content)) {
      for (const part of line.message.content) if (part?.type === "tool_result" && part.is_error && byId.has(part.tool_use_id)) byId.get(part.tool_use_id).ok = false;
    } else if (line.type === "result") {
      // A round that failed ends in Claude Code's own error text, which may name a folder: only that it failed.
      if (line.is_error || (line.subtype && line.subtype !== "success")) conclude("fail", "没跑成");
      else conclude("done", line.result);
    }
    // ---- Codex
    else if (line.type === "item.completed" && line.item && typeof line.item === "object") {
      const item = line.item;
      if (item.type === "command_execution") {
        const program = programOf(item.command);
        const made = step("run", program ? `跑 ${program}` : "跑命令");
        if (Number.isInteger(item.exit_code) && item.exit_code !== 0) made.ok = false;
        add(made);
      } else if (item.type === "file_change") {
        for (const change of (Array.isArray(item.changes) ? item.changes : []).slice(0, 3)) {
          const file = nameOf(change?.path);
          if (file) add(step("edit", `${change.kind === "add" ? "写" : change.kind === "delete" ? "删" : "改"} ${file}`));
        }
      } else if (item.type === "agent_message") add(step("say", firstLine(item.text)));
      else if (item.type === "web_search") add(step("web", item.query ? `搜：${plain(item.query, 40)}` : "上网搜"));
      else if (item.type === "mcp_tool_call") add(step("tool", `用 ${plain(item.server, 20) || "MCP"} 的 ${plain(item.tool, 30) || "工具"}`));
    } else if (line.type === "turn.completed") {
      const last = steps.at(-1);
      if (last?.kind === "say") Object.assign(last, { kind: "done" });
    } else if (line.type === "turn.failed" || (line.type === "error" && typeof line.message === "string")) conclude("fail", "没跑成"); // its message may name a folder
  }
  return steps.slice(-MOST).map(({ kind, words, ok }) => ({ kind, words, ok }));
}

const kept = new Map(); // a record's path -> { size, changed, steps }

/**
 * The steps of round `id`, from what the worker under `home` kept of it: its latest try, and that try's latest turn.
 * None when there is no such record here (the round ran on another computer, or its record has been cleared away).
 * Only the end of a long record is read, and one that hasn't changed since it was last read isn't read again.
 */
export function stepsOfRun(home, id) {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return [];
  const runs = path.join(home, "worker", "runs");
  try {
    const latest = (folder, pattern) => {
      let best = null;
      for (const name of readdirSync(folder)) {
        const found = pattern.exec(name);
        if (found && (!best || Number(found[1]) > best.number)) best = { name, number: Number(found[1]) };
      }
      return best;
    };
    const attempt = latest(runs, new RegExp(`^${id}-(\\d{1,6})$`));
    if (!attempt) return [];
    const folder = path.join(runs, attempt.name);
    // The folder and the record are what the worker made: neither a link to somewhere else.
    if (!lstatSync(folder).isDirectory()) return [];
    const turn = latest(folder, /^stdout-(\d{1,6})\.log$/);
    if (!turn) return [];
    const file = path.join(folder, turn.name);
    if (!lstatSync(file).isFile()) return [];
    // Not blocking: a pipe put there in place of the record between the look and the open would hold the town up.
    const opened = openSync(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    try {
      const info = fstatSync(opened);
      if (!info.isFile()) return [];
      const was = kept.get(file);
      if (was && was.size === info.size && was.changed === info.mtimeMs) return was.steps;
      const from = Math.max(0, info.size - TAIL);
      const bytes = Buffer.alloc(info.size - from);
      const read = readSync(opened, bytes, 0, bytes.length, from);
      let text = bytes.subarray(0, read).toString("utf8");
      // Begun in the middle of a line: that line is no line.
      if (from > 0) text = text.slice(text.indexOf("\n") + 1);
      const steps = stepsIn(text);
      kept.set(file, { size: info.size, changed: info.mtimeMs, steps });
      if (kept.size > 60) kept.delete(kept.keys().next().value);
      return steps;
    } finally {
      closeSync(opened);
    }
  } catch {
    // Not there, or not to be read.
    return [];
  }
}
