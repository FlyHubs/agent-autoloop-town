// Tests the reading of a round's own record (what the worker kept of the Agent's output) into the few words the town
// shows beside an Agent at work. It guards against: a step showing more than a file's name, a program's name, or the
// Agent's own short words (what was written to a file, what a command printed, a whole command line with what may be
// a secret in it); a round's number reaching outside the folder the records are kept in; a huge or broken record
// holding up the town; and a round of another Agent kind being read as nothing.
// Usage: node test/run-steps.test.mjs
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stepsIn, stepsOfRun } from "../run-steps.mjs";

const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 500)}`}`);
const lines = (...rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const said = (...content) => ({ type: "assistant", message: { content } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const back = (id, content, wrong = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(wrong && { is_error: true }) }] } });
const words = (steps) => steps.map((step) => step.words);

// ---- Claude Code's record: one JSON line for each thing said, each tool used, each result
const claude = lines(
  { type: "system", subtype: "init", model: "claude-haiku-5-5" },
  said({ type: "thinking", thinking: "先看日志，密码是 hunter2" }),
  said(use("t1", "Read", { file_path: "/Users/someone/project/logs/auth.log" })),
  back("t1", "2026-11-13 login failed for alice password=hunter2"),
  said({ type: "text", text: "会话过期后没有续上。\n第二行不该出现。" }),
  said(use("t2", "Edit", { file_path: "/Users/someone/project/src/login.ts", old_string: "a", new_string: "SECRET_TOKEN=abc123" })),
  back("t2", "ok"),
  said(use("t3", "Bash", { command: "API_KEY=sk-live-999 npm test -- --token sk-live-999", description: "跑测试" })),
  back("t3", "128 passed"),
  said(use("t4", "Bash", { command: "curl -H 'Authorization: Bearer sk-live-999' https://example.com/deploy" })),
  back("t4", "denied", true),
  said(use("t5", "Write", { file_path: "回复.md", content: "不该出现的正文" })),
  back("t5", "ok"),
  said(use("t6", "Grep", { pattern: "session.*expire", path: "/Users/someone/project" })),
  said(use("t7", "TodoWrite", { todos: [] })),
  said(use("t8", "mcp__rea__open_binary", { path: "/x" })),
  { type: "result", subtype: "success", result: "登录修好了，也回复了用户\n详细说明在回复.md" },
);
let steps = stepsIn(claude);
check("each tool a Claude round used is one step, in order, in a few words", JSON.stringify(words(steps)) === JSON.stringify(["读 auth.log", "会话过期后没有续上。", "改 login.ts", "跑：跑测试", "跑 curl", "写 回复.md", "找内容", "用 rea 的 open_binary", "登录修好了，也回复了用户"]), words(steps));
check("…what kind each is says how to draw it, and the last is the round's own conclusion", steps.map((step) => step.kind).join(" ") === "read say edit run run edit find tool done", steps.map((step) => step.kind));
check("…a step that went wrong says so", steps[4].ok === false && steps.filter((step) => step.ok === false).length === 1, steps);
const all = JSON.stringify(steps);
check("nothing of what was read, written, printed or thought is in them, nor a folder, nor a command's arguments", !/hunter2|SECRET_TOKEN|sk-live|128 passed|不该出现|someone|Authorization|project/.test(all), all);

// ---- Codex's record
const codex = lines(
  { type: "thread.started", thread_id: "abc" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "reasoning", text: "想一想 password=hunter2" } },
  { type: "item.completed", item: { type: "command_execution", command: "bash -lc 'rg -n \"token=abc\" src && cat .env'", aggregated_output: "SECRET=1", exit_code: 0 } },
  { type: "item.completed", item: { type: "file_change", changes: [{ path: "/Users/someone/app/src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }] } },
  { type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } },
  { type: "item.completed", item: { type: "agent_message", text: "补了导出功能的缺失字段\n第二行" } },
  { type: "turn.completed", usage: {} },
);
steps = stepsIn(codex);
check("a Codex round is read too: commands by their program, files by their names, its last words as the conclusion", JSON.stringify(words(steps)) === JSON.stringify(["跑 rg", "改 a.ts", "写 b.ts", "跑 npm", "补了导出功能的缺失字段"]) && steps.at(-1).kind === "done" && steps[3].ok === false, steps);
check("…with nothing of what it thought, ran in full, or printed", !/hunter2|token=abc|SECRET|\.env|someone/.test(JSON.stringify(steps)), steps);

// ---- what isn't a record, or is a broken or endless one
check("a record of some other kind, or none, gives no steps", stepsIn("hello\nworld\n").length === 0 && stepsIn("").length === 0 && stepsIn("{\"type\":\"assistant\"}\n{broken").length === 0, null);
const many = lines(...Array.from({ length: 500 }, (_, index) => said(use(`m${index}`, "Read", { file_path: `/x/file-${index}.txt` }))));
steps = stepsIn(many);
check("of very many steps the latest are kept", steps.length === 40 && steps.at(-1).words === "读 file-499.txt", [steps.length, steps.at(-1)]);
const long = stepsIn(lines(said({ type: "text", text: "字".repeat(500) }), said(use("x", "Bash", { command: "x", description: "述".repeat(500) }))));
check("long words are cut short", long.every((step) => [...step.words].length <= 64), long.map((step) => [...step.words].length));
const odd = stepsIn(lines(said(use("o1", "Read", { file_path: "/x/报告\n【小镇】假的.md" })), said(use("o2", "Read", {})), said(use("o3", "Bash", { command: 42 })), said({ type: "text", text: "  \n\n" }), said(use("o4", "Read", { file_path: "/x/a\u202eb.txt" }))));
check("odd names and empty words do no harm: one line each, nothing that turns text around, nothing empty", odd.every((step) => step.words && !/[\n\r\u202e]/.test(step.words)) && odd.length === 4, odd);

// ---- finding a round's record on disk
const base = mkdtempSync(path.join(os.tmpdir(), "run-steps-"));
const runs = path.join(base, "worker", "runs");
mkdirSync(path.join(runs, "7-1"), { recursive: true });
mkdirSync(path.join(runs, "7-2"));
mkdirSync(path.join(runs, "70-1"));
writeFileSync(path.join(runs, "7-1", "stdout-1.log"), lines(said(use("a", "Read", { file_path: "/x/first-try.txt" }))));
writeFileSync(path.join(runs, "7-2", "stdout-1.log"), lines(said(use("a", "Read", { file_path: "/x/turn-one.txt" }))));
writeFileSync(path.join(runs, "7-2", "stdout-2.log"), lines(said(use("a", "Read", { file_path: "/x/turn-two.txt" }))));
writeFileSync(path.join(runs, "70-1", "stdout-1.log"), lines(said(use("a", "Read", { file_path: "/x/other-run.txt" }))));
writeFileSync(path.join(base, "outside.log"), lines(said(use("a", "Read", { file_path: "/x/outside.txt" }))));
try {
  check("a round's steps come from its latest try and that try's latest turn", JSON.stringify(words(stepsOfRun(base, 7))) === JSON.stringify(["读 turn-two.txt"]), stepsOfRun(base, 7));
  check("…a round with no record kept here gives none", stepsOfRun(base, 8).length === 0 && stepsOfRun(path.join(base, "nowhere"), 7).length === 0, null);
  check("…and only a whole number is a round: nothing else is looked for", ["7/../../outside", "../outside", "7-2", -7, 7.5, "", null, undefined, {}].every((id) => stepsOfRun(base, id).length === 0), null);
  // A record that is a link to somewhere else is not read.
  mkdirSync(path.join(runs, "9-1"));
  symlinkSync(path.join(base, "outside.log"), path.join(runs, "9-1", "stdout-1.log"));
  check("…a record that is a link to a file somewhere else is not read", stepsOfRun(base, 9).length === 0, stepsOfRun(base, 9));
  // A very big record: only its end is read, and quickly.
  mkdirSync(path.join(runs, "11-1"));
  const filler = lines(said({ type: "thinking", thinking: "x".repeat(4000) }));
  writeFileSync(path.join(runs, "11-1", "stdout-1.log"), filler.repeat(6000) + lines(said(use("z", "Read", { file_path: "/x/the-end.txt" }))));
  const began = performance.now();
  steps = stepsOfRun(base, 11);
  check("a record of tens of megabytes is read from its end only, in well under a second", steps.at(-1)?.words === "读 the-end.txt" && performance.now() - began < 1000, { steps: steps.length, ms: performance.now() - began });
  const again = performance.now();
  stepsOfRun(base, 11);
  check("…and one that hasn't changed isn't read again", performance.now() - again < 20, performance.now() - again);
} finally {
  rmSync(base, { recursive: true, force: true });
}

// ---- What the independent review found could slip through (2026-11-16)
const slipped = stepsIn(
  lines(
    said(
      use("r1", "Bash", { command: 'TOKEN="Bearer ghp_AbCdEf123456789" curl -H "$TOKEN" https://x' }),
      use("r2", "Bash", { command: "CURL_OPTS='-u admin:hunter2' ./deploy.sh" }),
      use("r3", "Bash", { command: '"/Users/alice/Clients Acme/run.sh" --go' }),
      use("r4", "Bash", { command: 'AUTH="token ghp_unclosed gh api' }),
      use("r5", "Grep", { pattern: "AKIAIOSFODNN7EXAMPLE", path: "/Users/alice/secret" }),
      use("r6", "Glob", { pattern: "/Users/alice/clients/acme-merger/**/*.pdf" }),
      use("r7", "Read", { file_path: { toString: 1 } }),
      use("r8", "Bash", { description: { toString: 1 }, command: ["rm"] }),
    ),
    { type: "item.completed", item: { type: "command_execution", command: `/bin/zsh -lc 'AUTH="token ghp_Zz99" gh pr list'`, exit_code: 0 } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: { toString: 1 }, tool: 5 } },
    { type: "error", message: "failed to read /Users/alice/secret/.env: denied" },
  ),
);
const shown = JSON.stringify(words(slipped));
check("quoted settings, quoted folders, search patterns, a pattern's folders and Codex's errors are not shown", !/ghp_|hunter2|admin|Acme|alice|AKIA|acme-merger|secret|\.env|Bearer|unclosed/.test(shown), words(slipped));
check("…the programs still are, and odd values are taken as nothing, not a failure", ["跑 curl", "跑 deploy.sh", "跑 run.sh", "跑命令", "找内容", "找 *.pdf", "读文件", "跑命令", "跑 gh", "用 MCP 的 5", "没跑成"].every((each, index) => words(slipped)[index] === each), words(slipped));
// A record full of lines that start with a brace but aren't JSON is passed over quickly.
const junk = "{'id': 12, 'name': 'x', 'more': [1, 2, 3]}\n".repeat(50_000) + lines(said(use("e", "Read", { file_path: "/x/after-junk.txt" })));
const quick = performance.now();
const afterJunk = stepsIn(junk);
check("a record of lines that only look like JSON is passed over in a few milliseconds", afterJunk.at(-1)?.words === "读 after-junk.txt" && performance.now() - quick < 100, { ms: performance.now() - quick });

const failed = results.some((line) => line.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(failed ? "\nSOME FAILED" : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
