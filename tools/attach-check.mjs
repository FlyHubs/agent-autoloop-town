// Exercises the town server's attachment handling against the live town (the sandbox hub), then sends one real task
// with two attachments and waits to see whether the Agent could read them.
// Usage: node attach-check.mjs <town url> <working folder of the rule> [--send]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [town, folder, send] = process.argv.slice(2);
const page = await (await fetch(town)).text();
const token = /token: "([^"]+)"/.exec(page)?.[1];
if (!token) throw new Error("no token in the page");
const call = async (method, where, body, headers = {}) => {
  const response = await fetch(new URL(where, town), { method, headers: { "x-town-token": token, ...headers }, body });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const upload = (name, body) => call("POST", `/api/uploads?name=${encodeURIComponent(name)}`, body, { "content-type": "application/octet-stream" });
const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)}`}`);

const plain = await upload("需求说明.md", "# 需求\n\n1. 登录页的按钮太小\n2. 导出要支持 CSV\n");
check("a text file goes up", plain.status === 200 && plain.data.name === "需求说明.md" && plain.data.size > 0, plain);
const sneaky = await upload("../../etc/passwd", "x");
check("a name with folders in it is cut down to the name", sneaky.status === 200 && sneaky.data.name === "passwd", sneaky);
const hidden = await upload(".bashrc", "x");
check("a hidden name loses its dot", hidden.status === 200 && hidden.data.name === "bashrc", hidden);
const odd = await upload('a:b*c?"d<e>f|g.txt', "x");
check("characters a file system chokes on are replaced", odd.status === 200 && odd.data.name === "a_b_c__d_e_f_g.txt", odd);
const empty = await upload("空的.txt", "");
check("an empty file is refused", empty.status === 400, empty);
const big = await upload("big.bin", new Uint8Array(21 * 1024 * 1024));
check("a file over 20 MB is refused", big.status === 413 || big.status === 400, { status: big.status, data: big.data });
const stranger = await fetch(new URL("/api/uploads?name=x.txt", town), { method: "POST", body: "x" });
check("no upload without the page's token", stranger.status === 403, stranger.status);
for (const each of [sneaky, hidden, odd]) check("a waiting file can be taken back", (await call("DELETE", `/api/uploads/${each.data.id}`)).status === 200, each.data.id);
const json = { "content-type": "application/json" };
const ghost = await call("POST", "/api/tasks", JSON.stringify({ type: "task.new", text: "x", files: ["0".repeat(24)] }), json);
check("a task naming a file that isn't waiting is refused", ghost.status === 400, ghost);
const gone = await call("POST", "/api/tasks", JSON.stringify({ type: "task.new", text: "x", files: [sneaky.data.id] }), json);
check("a task naming a file that was taken back is refused", gone.status === 400, gone);

if (send === "--send") {
  const second = await upload("需求说明.md", "（同名的第二份）\n3. 夜间模式\n");
  const inbox = path.join(folder, ".town-inbox");
  const before = existsSync(inbox) ? readdirSync(inbox) : [];
  const mark = `attach-test-${Date.now()}.md`;
  const text = `读一下随任务附上的两个附件，把里面编号的三条需求原样写进 ${mark}，每条一行，不要加别的内容。`;
  const sent = await call("POST", "/api/tasks", JSON.stringify({ type: "task.new", text, files: [plain.data.id, second.data.id] }), json);
  check("the task with two attachments is taken in by the hub", sent.status === 200 || sent.status === 201 || sent.status === 202, sent);
  const added = (existsSync(inbox) ? readdirSync(inbox) : []).filter((name) => !before.includes(name) && name !== ".gitignore");
  check("one new folder in the inbox", added.length === 1, added);
  const landed = added.length ? readdirSync(path.join(inbox, added[0])).sort() : [];
  check("both files are in it, the second under a name of its own", JSON.stringify(landed) === JSON.stringify(["需求说明-2.md", "需求说明.md"]), landed);
  check("git is told to leave the inbox alone", existsSync(path.join(inbox, ".gitignore")) && readFileSync(path.join(inbox, ".gitignore"), "utf8") === "*\n", null);
  const again = await call("POST", "/api/tasks", JSON.stringify({ type: "task.new", text: "x", files: [plain.data.id] }), json);
  check("once sent, the files no longer wait on the server", again.status === 400, again);
  // Now the real thing: did the Agent read them?
  const began = Date.now();
  let run = null;
  while (Date.now() - began < 240_000) {
    await new Promise((done) => setTimeout(done, 4000));
    const state = (await call("GET", "/api/state")).data;
    run = (state.runs ?? []).filter((each) => each.rule === "临时任务").sort((a, b) => b.id - a.id)[0];
    if (run && ["done", "nothing", "cancelled"].includes(run.state) && new Date(run.createdAt).getTime() >= began - 5000) break;
  }
  const out = path.join(folder, mark);
  const wrote = existsSync(out) ? readFileSync(out, "utf8") : null;
  check("the Agent's round finished", run && run.state === "done", run && { id: run.id, state: run.state, summary: run.summary, error: run.error });
  check("it wrote the three requirements it could only have read in the attachments", wrote !== null && wrote.includes("登录页的按钮太小") && wrote.includes("导出要支持 CSV") && wrote.includes("夜间模式"), wrote);
  results.push(`     round #${run?.id}: ${run?.state} · ${run?.summary ?? ""} · cost ${JSON.stringify(run?.usage ?? run?.cost ?? null)}`);
  results.push(`     wrote ${mark}: ${JSON.stringify(wrote)}`);
}
console.log(results.join("\n"));
