// Tests the town server's Feishu bridge with nothing real behind it: a hub made up here that only records what it is
// sent, a stand-in for the Feishu CLI, and a home folder of its own. Nothing is sent to Feishu and no Agent is started.
// It guards against: anyone but the owner starting work, in Feishu or through the page; a file or a name from outside
// landing somewhere it shouldn't, or a file from somewhere else being sent out; an ending said twice or not at all; a
// restart of the town leaving work it started without its answer; and one bad request stopping the server.
// Usage: node test/feishu-bridge.test.mjs
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [serverFile, fakeLark] = [path.join(here, "..", "server.mjs"), path.join(here, "fake-lark-cli")];
const base = mkdtempSync(path.join(os.tmpdir(), "bridge-check-"));
const home = path.join(base, "home");
const [work1, work2] = [path.join(base, "work1"), path.join(base, "work2")];
for (const each of [home, work1, work2]) mkdirSync(each);
const [eventsFile, logFile] = [path.join(base, "events.ndjson"), path.join(base, "lark.ndjson")];
writeFileSync(eventsFile, "");
writeFileSync(logFile, "");
const OWNER = "ou_" + "a".repeat(32);

// The made-up hub: takes events like the real one and remembers them, and says how each one's round is going. What the
// task says decides how its round goes, so a test can ask for any ending.
const taken = [];
const asked = new Map(); // event number -> how many times its rounds were asked after
const settled = new Map(); // event number -> what became of the question its round asked: "done" or "closed"
/** A moment of its own for each thing that happens to an event. */
const when = (number, step) => new Date(Date.UTC(2026, 0, 1, 0, number, step)).toISOString();
const hub = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk)).on("end", () => {
    const answer = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const ruleOf = (event) => (event.type === "task.docs" ? "文档整理" : "临时任务");
    // What the owner sees: the questions asked, and the rounds their answers started.
    if (request.method === "GET" && request.url === "/v1/state") {
      if (request.headers.authorization !== "Bearer owner-key") return answer(401, {});
      const asking = taken.map((event, index) => ({ event, number: index + 1 })).filter(({ event }) => event.detail.includes("要问"));
      const cards = asking.map(({ event, number }) => {
        const how = settled.get(number);
        return { id: 900 + number, kind: "ask", rule: ruleOf(event), title: "选哪个？", state: how ?? "open", createdAt: when(number, 1), decidedAt: how === "done" ? when(number, 2) : null, result: how === "done" ? "按你选的做了" : how === "closed" ? "任务取消了" : null };
      });
      const runs = asking.filter(({ number }) => settled.get(number) === "done").map(({ event, number }) => ({ id: 200 + number, rule: ruleOf(event), state: "done", createdAt: when(number, 2), finishedAt: when(number, 3), summary: "按你选的做了", events: [{ type: "card.answered" }] }));
      return answer(200, { cards: cards.filter((card) => card.state === "open"), recentCards: cards, runs });
    }
    if (request.headers.authorization !== "Bearer source-key") return answer(401, {});
    if (request.method === "POST" && request.url === "/v1/events") {
      const event = JSON.parse(body);
      const duplicate = taken.some((each) => each.id === event.id);
      if (!duplicate) taken.push(event);
      return answer(200, { event: taken.findIndex((each) => each.id === event.id) + 1, duplicate, routed: duplicate ? [] : [ruleOf(event)] });
    }
    const number = Number(/^\/v1\/events\/(\d+)$/.exec(request.url)?.[1]);
    const event = taken[number - 1];
    if (request.method !== "GET" || !event) return answer(404, {});
    const times = (asked.get(number) ?? 0) + 1;
    asked.set(number, times);
    const run = { run: 100 + number, rule: ruleOf(event), state: "claimed", attempts: 0, error: null, finishedAt: null, summary: null, events: [] };
    if (event.detail.includes("会重试") && times <= 2) Object.assign(run, { state: "queued", attempts: 1, error: "模型超时" });
    else if (event.detail.includes("没事")) Object.assign(run, { state: "nothing", summary: "没事可做：都已经是好的" });
    else if (event.detail.includes("停掉")) Object.assign(run, { state: "cancelled", summary: "本人停掉了" });
    else if (event.detail.includes("要问")) Object.assign(run, { state: "done", summary: "问了一个问题", finishedAt: when(number, 1) });
    else if (event.detail.includes("办不到") && times > 1) Object.assign(run, { state: "done", summary: "做不了：缺能运行命令的工具" });
    else if (event.detail.includes("慢慢做") && times <= 3) Object.assign(run, { state: "claimed" });
    else if (times > 1) Object.assign(run, { state: "done", summary: `改好了「${event.detail.split("\n")[0]}」` });
    answer(200, { event: number, routed: [run.rule], paused: [], runs: [run] });
  });
});
await new Promise((done) => hub.listen(0, "127.0.0.1", done));
writeFileSync(path.join(home, "config.json"), JSON.stringify({ url: `http://127.0.0.1:${hub.address().port}`, owner: "owner-key", source: { name: "local", key: "source-key" }, channels: { feishu: { key: "channel-key", user: OWNER } } }));
writeFileSync(path.join(home, "rules.json"), JSON.stringify({
  agents: { one: { name: "甲", use: "claude" }, two: { name: "乙", use: "codex" } },
  rules: [
    { name: "临时任务", when: { source: "local", types: ["task.new"] }, to: "one", cwd: work1, tell: "always" },
    { name: "文档整理", when: { source: "local", types: ["task.docs"] }, to: "two", cwd: work2, parallel: 2, resume: true },
    { name: "别的来源", when: { source: "github", types: ["task.new"] }, to: "two", cwd: work2 },
  ],
}));

const port = 3470 + Math.floor(Math.random() * 20);
let printed = "";
function start() {
  const child = spawn(process.execPath, [serverFile, "--home", home, "--port", String(port), "--lark", fakeLark, "--feishu-idle", "0.2"], { env: { ...process.env, FAKE_LARK_EVENTS: eventsFile, FAKE_LARK_LOG: logFile }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => (printed += chunk));
  child.stderr.on("data", (chunk) => (printed += chunk));
  return child;
}
let town = start();

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (test, ms = 20_000) => {
  for (const began = Date.now(); Date.now() - began < ms; await wait(200)) if (test()) return true;
  return false;
};
const larkLog = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const replies = () => larkLog().filter((each) => each.reply);
const under = (id) => replies().filter((each) => each.reply === id && !each.file && !each.image).map((each) => each.text);
const sentUnder = (id) => replies().filter((each) => each.reply === id && (each.file || each.image)).map((each) => ({ file: each.file, image: each.image, cwd: each.cwd }));
/** What the owner wrote, without what the bridge adds for the Agent after it. */
const wrote = (event) => event.detail.split("\n\n成果交付：")[0];
const outboxes = (folder) => (existsSync(path.join(folder, ".town-outbox")) ? readdirSync(path.join(folder, ".town-outbox")).filter((name) => name !== ".gitignore") : []);
let serial = 0;
/** Something arrives in Feishu. Says what was first answered under it, having waited long enough to know if nothing was. */
async function arrives(given, { silent = false } = {}) {
  const id = given.message_id ?? `om_test${++serial}`;
  const before = under(id).length;
  appendFileSync(eventsFile, JSON.stringify({ type: "im.message.receive_v1", chat_type: "p2p", sender_type: "user", sender_id: OWNER, message_type: "text", create_time: String(Date.now()), ...given, message_id: id }) + "\n");
  if (silent) await wait(1800);
  else await until(() => under(id).length > before, 9000);
  await wait(120);
  return { id, said: under(id)[before] ?? "" };
}
/** Stops the town and starts it again, as the owner's machine does when it is restarted. The stand-in CLI then hands
 * over every message it ever had once more, which a real one may do with those it wasn't sure were taken. */
async function restart() {
  const gone = new Promise((done) => town.once("exit", done));
  town.kill();
  await gone;
  printed = "";
  town = start();
  await until(() => printed.includes("飞书里私聊机器人的消息"), 6000);
  await wait(600);
}
const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 400)}`}`);
const inbox = (folder) => (existsSync(path.join(folder, ".town-inbox")) ? readdirSync(path.join(folder, ".town-inbox")).filter((name) => name !== ".gitignore").flatMap((stamp) => readdirSync(path.join(folder, ".town-inbox", stamp)).map((name) => name)) : []);

try {
  await until(() => printed.includes("飞书里私聊机器人的消息"), 6000);
  check("the server says it is listening to Feishu, and for whom", printed.includes(`只认 ${OWNER}`), printed);
  await wait(500);

  let got = await arrives({ sender_id: "ou_" + "b".repeat(32), content: "删库" }, { silent: true });
  check("a stranger's message starts nothing and gets no answer", taken.length === 0 && !got.said, { taken, got });
  got = await arrives({ chat_type: "group", content: "在群里说的" }, { silent: true });
  check("the owner's words in a group start nothing", taken.length === 0 && !got.said, { taken, got });
  got = await arrives({ sender_type: "bot", content: "机器人说的" }, { silent: true });
  check("a bot's message starts nothing", taken.length === 0 && !got.said, { taken, got });

  const first = await arrives({ content: "帮我整理一下 README" });
  check("the owner's words become a task for the first rule", taken.length === 1 && taken[0].type === "task.new" && wrote(taken[0]) === "帮我整理一下 README" && taken[0].id === `feishu-${first.id}`, taken);
  check("…and are answered: who it went to, and where the result will come", first.said === "已派给「甲」（临时任务）。做完会在这条消息下面回你。", first.said);
  check("the reply went in on stdin, as the bot, under a key of its own", replies().at(-1).textFlag === "-" && replies().at(-1).as === "bot" && /^town-[0-9a-f]{40}$/.test(replies().at(-1).key), replies().at(-1));
  check("the task tells the Agent where to leave what it makes for the owner, and the folder is there", /\n\n成果交付：.*\.town-outbox\/\d{8}-\d{6}-[0-9a-f]{4}\//.test(taken[0].detail) && outboxes(work1).length === 1 && !taken[0].summary.includes("成果交付"), { detail: taken[0].detail, boxes: outboxes(work1) });
  got = await arrives({ message_id: first.id, content: "帮我整理一下 README" }, { silent: true });
  check("the same message delivered twice starts nothing more", taken.length === 1 && under(first.id).filter((text) => text.startsWith("已派给")).length === 1, { taken: taken.length, under: under(first.id) });
  await until(() => under(first.id).length >= 2);
  check("when its round is done, that is said under the message that asked, with what was done", under(first.id)[1] === "✅ 做完了：改好了「帮我整理一下 README」", under(first.id));

  const picture = await arrives({ message_type: "image", content: "![Image](img_v3_abs_one)" });
  check("a picture on its own waits, and says so", /^收到 1 个附件：图片-\d{6}\.png（\d+ B）。接着发文字/.test(picture.said) && taken.length === 1, picture.said);
  const file = await arrives({ message_type: "file", content: '<file key="file_v3_doc" name="../../需求.md"/>' });
  check("a file waits with it, under its own name and no folders", /^收到 1 个附件：需求\.md（\d+ B）。接着发文字说要做什么，连同之前的共 2 个会随任务/.test(file.said), file.said);
  const both = await arrives({ content: "文档整理：把附件整理成清单" });
  const sent = taken[1];
  check("\"规则名：…\" picks that rule, and the name is not part of the task", taken.length === 2 && sent?.type === "task.docs" && sent.detail.startsWith("把附件整理成清单\n\n附件（"), sent);
  check("the task lists both files where the Agent can read them", /- \.town-inbox\/\d{8}-\d{6}-[0-9a-f]{4}\/图片-\d{6}\.png（/.test(sent?.detail ?? "") && /- \.town-inbox\/[^/]+\/需求\.md（/.test(sent?.detail ?? "") && sent.summary.endsWith("〔附件 2〕"), sent);
  check("both files are in that rule's working folder, and only there", inbox(work2).length === 2 && inbox(work2).includes("需求.md") && inbox(work1).length === 0, { work1: inbox(work1), work2: inbox(work2) });
  check("…and the answer says what went", both.said === "已派给「乙」（文档整理，带 2 个附件）。做完会在这条消息下面回你。", both.said);
  check("files were fetched as the bot, from the message they came in", larkLog().filter((each) => each.download).every((each) => each.message.startsWith("om_test") && each.type === (each.download.startsWith("img_") ? "image" : "file")), larkLog().filter((each) => each.download));
  got = await arrives({ content: "再来一件，不带附件" });
  check("once sent, files don't go with the next task too", taken.length === 3 && wrote(taken[2]) === "再来一件，不带附件", taken[2]);

  got = await arrives({ content: "很久以前发的", create_time: String(Date.now() - 11 * 60_000) });
  check("a message that arrives long after it was sent is not acted on", taken.length === 3 && got.said.startsWith("这条消息到得太晚了（11 分钟前发的）"), got.said);
  got = await arrives({ message_type: "audio", content: "<audio key=\"file_v3_voice\"/>" });
  check("a kind of message it can't take says so", taken.length === 3 && got.said === "这种消息我还接不了：发文字、图片或文件。", got.said);
  got = await arrives({ content: "帮助" });
  check("\"帮助\" explains, naming the rules that take tasks from here and no others", taken.length === 3 && got.said.includes("交给「甲」（临时任务）") && got.said.includes("可用的：临时任务、文档整理。") && !got.said.includes("别的来源"), got.said);

  got = await arrives({ message_type: "file", content: '<file key="file_v3_toobig" name="大文件.zip"/>' });
  check("a file over the limit is turned away", got.said === "「大文件.zip」没取下来：超过 20 MB", got.said);
  got = await arrives({ message_type: "image", content: '{"image_key":"img_v3_gone"}' });
  check("a picture that can't be fetched says why", got.said === "有张图片没取下来：resource not found", got.said);
  got = await arrives({ message_type: "post", content: "看这张图\n![Image](img_v3_inline)\n改一下配色" });
  check("words with a picture in them go as one task with one file", taken.length === 4 && taken[3].detail.startsWith("看这张图\n\n改一下配色\n\n附件（") && inbox(work1).length === 1 && got.said === "已派给「甲」（临时任务，带 1 个附件）。做完会在这条消息下面回你。", { event: taken[3], said: got.said, work1: inbox(work1) });

  await arrives({ message_type: "image", content: "![Image](img_v3_two)" });
  got = await arrives({ content: "清空附件" });
  check("\"清空附件\" drops what was waiting", got.said === "丢掉了 1 个还没用上的附件。", got.said);
  got = await arrives({ content: "这件不该带附件" });
  check("…so the next task carries nothing", taken.length === 5 && wrote(taken[4]) === "这件不该带附件" && inbox(work1).length === 1, taken[4]);
  got = await arrives({ content: '{"text":"包在 JSON 里的字"}' });
  check("words wrapped in JSON are unwrapped", taken.length === 6 && wrote(taken[5]) === "包在 JSON 里的字", taken[5]);
  got = await arrives({ content: "文档整理：" });
  check("a rule's name with nothing after it is not a task", taken.length === 6 && got.said.startsWith("任务是空的"), got.said);

  // How a round ends is said under the message that started it, whichever way it ends.
  const idle = await arrives({ content: "检查一遍，大概没事" });
  const stopped = await arrives({ content: "这一件会被停掉" });
  const retried = await arrives({ content: "这一件会重试" });
  const cannot = await arrives({ content: "这一件办不到" });
  await until(() => under(idle.id).length >= 2 && under(stopped.id).length >= 2 && under(retried.id).length >= 3 && under(cannot.id).length >= 2);
  check("a round that says it couldn't do the thing is not called done", under(cannot.id)[1] === "没做成：缺能运行命令的工具", under(cannot.id));
  check("a round that found nothing to do says so", under(idle.id)[1] === "看过了，没事可做：都已经是好的", under(idle.id));
  check("a round that was stopped says so", under(stopped.id)[1] === "没做成，已经停下：本人停掉了", under(stopped.id));
  check("a round that failed once says so once, then how it ended", JSON.stringify(under(retried.id).slice(1)) === JSON.stringify(["这一次没跑成（模型超时）。中台会自动重试，有结果再告诉你。", "✅ 做完了：改好了「这一件会重试」"]), under(retried.id));
  // A round that ends on a question has not done the thing: that is said, and then what the answer led to.
  const asks = await arrives({ content: "这一件要问我" });
  const dropped = await arrives({ content: "这一件要问，但问题会作废" });
  await until(() => under(asks.id).length >= 2 && under(dropped.id).length >= 2);
  check("a round that stopped to ask is not called done: the question is pointed to", under(asks.id)[1] === "它停下来等你拍板：「选哪个？」。在下面的卡片上选一个，或者直接写回答。" && under(asks.id).length === 2, under(asks.id));
  settled.set(taken.findIndex((event) => event.id === `feishu-${asks.id}`) + 1, "done");
  settled.set(taken.findIndex((event) => event.id === `feishu-${dropped.id}`) + 1, "closed");
  await until(() => under(asks.id).length >= 3 && under(dropped.id).length >= 3);
  check("…and once it is answered, what the next round did is said under the same message", under(asks.id)[2] === "✅ 做完了：按你选的做了", under(asks.id));
  check("a question that was withdrawn says so", under(dropped.id)[2] === "那个问题不用回答了：任务取消了", under(dropped.id));
  // What the Agent leaves in the folder made for it comes back under the message: plain files, and nothing they point at.
  const report = await arrives({ content: "写一份周报文档" });
  const box = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(box, "周报.md"), "# 周报\n");
  writeFileSync(path.join(box, "图表.png"), "not really a picture");
  // A name the Agent chose to read backwards from the middle on ("报告dm.exe" shown as "报告exe.md"): sent under a plain one.
  writeFileSync(path.join(box, "报告\u202edm.exe"), "x");
  writeFileSync(path.join(box, "空的.txt"), "");
  symlinkSync("/etc/hosts", path.join(box, "别处的.txt"));
  mkdirSync(path.join(box, "里层"));
  writeFileSync(path.join(box, "里层", "不该发.md"), "x");
  await until(() => sentUnder(report.id).length >= 3 && under(report.id).length >= 3);
  check("the files it left are sent under the message once the work is done, pictures as pictures, under plain names", JSON.stringify(sentUnder(report.id).map(({ file, image }) => ({ file, image }))) === JSON.stringify([{ file: "./周报.md" }, { image: "./图表.png" }, { file: "./报告_dm.exe" }]), sentUnder(report.id));
  check("…from a copy of its own, not from inside the Agent's folder", sentUnder(report.id).every((each) => !each.cwd.startsWith(realpathSync(work1))), sentUnder(report.id));
  check("a link is not followed, a folder not gone into, and an empty file is named as not sent", JSON.stringify(under(report.id)) === JSON.stringify(["已派给「甲」（临时任务）。做完会在这条消息下面回你。", "✅ 做完了：改好了「写一份周报文档」", "「空的.txt」是空的，没发"]), under(report.id));
  await wait(3500);
  check("a task that left nothing leaves no folder behind; one that did keeps its own", JSON.stringify(outboxes(work1)) === JSON.stringify([path.basename(box)]) && outboxes(work2).length === 0, { work1: outboxes(work1), work2: outboxes(work2) });
  check("each ending is said once, however often the hub is asked", under(first.id).length === 2 && under(idle.id).length === 2 && under(retried.id).length === 3 && under(asks.id).length === 3 && asked.get(1) === 2, { first: under(first.id), idle: under(idle.id), retried: under(retried.id), askedOfFirst: asked.get(1) });
  check("everything said has a key of its own", new Set(replies().map((each) => each.key)).size === replies().length, replies().map((each) => each.key));

  // What's said soon after goes on with the same matter, for a rule that keeps a matter's rounds in one conversation.
  const one = await arrives({ content: "文档整理：先写一版" });
  const two = await arrives({ content: "文档整理：再改短一点" });
  check("words soon after a task go on with the same matter, and say so", /^feishu:om_test\d+$/.test(taken.at(-1).subject) && taken.at(-1).subject === taken.at(-2).subject && two.said === "已交给「乙」接着做（文档整理，带着刚才的上下文）。做完会在这条消息下面回你。", { subjects: taken.slice(-2).map((event) => event.subject), said: two.said });
  got = await arrives({ content: "新话题" });
  check("\"新话题\" ends the matter", got.said === "好，下一条消息从头开始，不带之前的上下文。", got.said);
  const anew = await arrives({ content: "文档整理：另一件事" });
  check("…so the next words are a matter of their own", taken.at(-1).subject === `feishu:${anew.id}` && anew.said === "已派给「乙」（文档整理）。做完会在这条消息下面回你。", { subject: taken.at(-1).subject, said: anew.said });
  const back = await arrives({ content: "文档整理：还是之前那件", root_id: one.id });
  check("a reply under an earlier task goes on with that one", taken.at(-1).subject === taken.find((event) => event.id === `feishu-${one.id}`).subject && back.said.startsWith("已交给「乙」接着做"), { subject: taken.at(-1).subject, said: back.said });
  await until(() => under(back.id).length >= 2 && under(two.id).length >= 2 && under(one.id).length >= 2);
  await wait(13_500);
  const later = await arrives({ content: "文档整理：隔了很久才发的" });
  check("after a quiet while the next words start anew", taken.at(-1).subject === `feishu:${later.id}` && later.said.startsWith("已派给「乙」"), { subject: taken.at(-1).subject, said: later.said });

  // An SVG left to be handed back goes as a picture first: it can't be looked at in a chat.
  const poster = await arrives({ content: "做一张海报" });
  const posterBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(posterBox, "海报.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#223344"/></svg>');
  await until(() => sentUnder(poster.id).some((each) => each.file));
  const went = sentUnder(poster.id);
  const canDraw = existsSync("/usr/bin/sips");
  check(`an SVG goes ${canDraw ? "as a JPG picture first, then " : ""}as itself`, went.at(-1)?.file === "./海报.svg" && (canDraw ? went.length === 2 && /^\.\/[0-9a-f]{16}\.jpg$/.test(went[0].image) && went[0].cwd !== realpathSync(posterBox) : went.length === 1), went);
  check("the task says so, so an Agent that can run nothing knows to write one", taken.at(-1).detail.includes("SVG 会先转成 JPG 图片再发"), taken.at(-1).detail);

  // The hub keeps one line of what an Agent says. What it has to say at more length is said as words, not sent as a file.
  const wonders = await arrives({ content: "说说这张图里有什么" });
  const wondersBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(wondersBox, "回复.md"), "图里有三样东西：\n1. 一只猫\n2. 一张桌子\n");
  await until(() => under(wonders.id).length >= 3);
  await wait(800);
  check("what the Agent wrote to the file for its reply is said as words under the message, marked as the Agent's, and not sent as a file", JSON.stringify(under(wonders.id).slice(1)) === JSON.stringify(["✅ 做完了：改好了「说说这张图里有什么」", "Agent 的回复：\n图里有三样东西：\n1. 一只猫\n2. 一张桌子"]) && sentUnder(wonders.id).length === 0, { under: under(wonders.id), sent: sentUnder(wonders.id) });
  check("…and the task tells the Agent of that file", taken.at(-1).detail.includes("「回复.md」"), taken.at(-1).detail);
  const rambles = await arrives({ content: "写一篇很长的说明" });
  const ramblesBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(ramblesBox, "回复.txt"), "长".repeat(6500));
  await until(() => under(rambles.id).length >= 3 && sentUnder(rambles.id).length >= 1);
  check("a reply too long to say whole is said as far as it goes, and sent as the file too", under(rambles.id)[2] === `Agent 的回复：\n${"长".repeat(6000)}\n……（太长了，全文在随后的文件里）` && JSON.stringify(sentUnder(rambles.id).map((each) => each.file)) === JSON.stringify(["./回复.txt"]), { said: under(rambles.id)[2]?.length, sent: sentUnder(rambles.id) });

  // The door the page uses is the same one, and still works.
  // The page is the owner's hands on the hub, so it is given only to someone holding the key printed when the town starts.
  const bare = await fetch(`http://127.0.0.1:${port}/`);
  const bareText = await bare.text();
  check("the page is not handed over without the key in its address", bare.status === 403 && !/token: "[\w-]{20,}"/.test(bareText), { status: bare.status, text: bareText.slice(0, 200) });
  const wrongKey = await fetch(`http://127.0.0.1:${port}/?k=${"x".repeat(32)}`);
  check("…nor with a wrong one", wrongKey.status === 403, wrongKey.status);
  const pageKey = readFileSync(path.join(home, "town", "key"), "utf8").trim();
  check("the key is long, is said when the town starts, and is kept where only the owner reads", /^[\w-]{32,}$/.test(pageKey) && printed.includes(`/?k=${pageKey}`) && (statSync(path.join(home, "town", "key")).mode & 0o077) === 0, { length: pageKey.length });
  const opened = await fetch(`http://127.0.0.1:${port}/?k=${pageKey}`);
  const page = await opened.text();
  check("with the key the page opens, and no script in it runs unless the server put it there", opened.status === 200 && /script-src 'self' 'nonce-[\w-]{16,}'/.test(opened.headers.get("content-security-policy") ?? "") && !(opened.headers.get("content-security-policy") ?? "").includes("script-src 'self' 'unsafe-inline'"), opened.headers.get("content-security-policy"));
  const token = /token: "([^"]+)"/.exec(page)[1];
  // An address no browser would write itself, sent as it stands: it must get an answer, and the server must go on.
  const odd = await new Promise((done) => request({ host: "127.0.0.1", port, path: "//", headers: { host: `127.0.0.1:${port}` } }, (answer) => (answer.resume(), done(answer.statusCode))).on("error", () => done("no answer")).setTimeout(4000, function () { this.destroy(new Error("slow")); }).end());
  const after = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-town-token": token } }).then((answer) => answer.status, () => "gone");
  check("an address that can't be read is turned away, and the server goes on", odd === 400 && after === 200, { odd, after });
  const sofar = taken.length;
  const typed = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", "x-town-token": token }, body: JSON.stringify({ type: "task.new", text: "页面上派的" }) });
  check("a task typed into the town still goes through", typed.status === 200 && taken.length === sofar + 1 && taken.at(-1).detail === "页面上派的" && taken.at(-1).id.startsWith("town-") && /^town:[0-9a-f]{12}$/.test(taken.at(-1).subject), { status: typed.status, last: taken.at(-1) });
  const refused = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", "x-town-token": token }, body: JSON.stringify({ type: "nope", text: "x" }) });
  check("…and a bad one is still refused with a reason", refused.status === 400 && (await refused.json()).error === "类型要是 task. 开头", refused.status);
  // Where the page stands on a static site there is no server to look in the models folder: a list stands in for it.
  const listed = JSON.parse(readFileSync(path.join(here, "..", "models", "index.json"), "utf8"));
  let tracked = null;
  try {
    tracked = execFileSync("git", ["ls-files", "models"], { cwd: path.join(here, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((name) => name.endsWith(".glb")).map((name) => name.slice("models/".length, -4)).sort();
  } catch {
    // Not a git checkout: only that each listed model is there can be checked.
  }
  check("the list of models names the models that come with the town, all of them and no others", listed.every((name) => existsSync(path.join(here, "..", "models", `${name}.glb`))) && (!tracked?.length || JSON.stringify(tracked) === JSON.stringify(listed)), { listed: listed.length, tracked: tracked?.length });
  check("nothing was said to anyone but in reply to the owner's own messages", replies().every((each) => each.reply.startsWith("om_test")), replies().map((each) => each.reply));

  // An Agent may write where it works. It must not be able to turn that into a file from somewhere else being sent
  // out, or into a file being written somewhere else.
  const elsewhere = path.join(base, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "别人的钥匙.txt"), "secret");
  rmSync(path.join(work1, ".town-outbox", ".gitignore"));
  symlinkSync(path.join(elsewhere, "新写出来的"), path.join(work1, ".town-outbox", ".gitignore"));
  const swapped = await arrives({ content: "把成果目录换成链接" });
  const swappedBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  rmdirSync(swappedBox);
  symlinkSync(elsewhere, swappedBox.replace(/\/$/, ""));
  const linked = await arrives({ content: "交一个硬链接和一个管道" });
  const linkedBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  linkSync(path.join(elsewhere, "别人的钥匙.txt"), path.join(linkedBox, "第二个名字.txt"));
  execFileSync("mkfifo", [path.join(linkedBox, "管道")]);
  writeFileSync(path.join(linkedBox, "正经的.md"), "ok");
  await until(() => under(swapped.id).length >= 2 && sentUnder(linked.id).length >= 1);
  await wait(1500);
  check("a folder for handing back that was swapped for a link to somewhere else hands back nothing", sentUnder(swapped.id).length === 0, sentUnder(swapped.id));
  check("a second name for a file kept elsewhere is not sent, a pipe doesn't hold things up, and the plain file beside them goes", JSON.stringify(sentUnder(linked.id).map((each) => each.file)) === JSON.stringify(["./正经的.md"]), sentUnder(linked.id));
  check("the note that keeps these folders out of git is not written through a link", !existsSync(path.join(elsewhere, "新写出来的")), readdirSync(elsewhere));
  rmSync(path.join(work1, ".town-outbox", ".gitignore"), { force: true });
  rmSync(swappedBox.replace(/\/$/, ""), { force: true });
  // A long name in a script of three bytes to the letter is longer than a disk allows unless it is cut by bytes.
  const longName = "很".repeat(120) + ".md";
  await arrives({ message_type: "file", content: `<file key="file_v3_long" name="${longName}"/>` });
  const withLong = await arrives({ content: "带一个名字很长的附件" });
  const landed = inbox(work1).find((name) => name.startsWith("很"));
  check("a file with a very long name still goes with its task, its ending kept", withLong.said.includes("带 1 个附件") && landed?.endsWith(".md") && Buffer.byteLength(landed) <= 255, { said: withLong.said, landed });
  await until(() => under(linked.id).length >= 2 && under(withLong.id).length >= 2);

  // The town is stopped while work it started is still going on, and started again. What it must remember to finish
  // that work is kept beside the hub's data, so nothing asked before the restart is left without its answer.
  await until(() => under(later.id).length >= 2 && under(poster.id).length >= 2);
  const old = serial;
  const saidBefore = replies().length;
  const takenBefore = taken.length;
  for (const kind of [".town-inbox", ".town-outbox"]) {
    mkdirSync(path.join(work1, kind, "20200101-000000-abcd"), { recursive: true });
    writeFileSync(path.join(work1, kind, "20200101-000000-abcd", "旧的.txt"), "x");
  }
  mkdirSync(path.join(work1, ".town-outbox", "不是小镇建的"));
  const slow = await arrives({ content: "慢慢做一份报告" });
  const slowBox = path.join(work1, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(slowBox, "报告.md"), "# 报告\n");
  const second = await arrives({ content: "这一件也要问我" });
  await until(() => under(second.id).length >= 2);
  const begun = await arrives({ content: "文档整理：慢慢做第一步" });
  await restart();
  const onward = await arrives({ content: "文档整理：接着做第二步" });
  const subjectOf = (message) => taken.find((event) => event.id === `feishu-${message.id}`)?.subject;
  check("words soon after a restart still go on with the matter begun before it", subjectOf(onward) === subjectOf(begun) && onward.said.startsWith("已交给「乙」接着做"), { begun: subjectOf(begun), onward: subjectOf(onward), said: onward.said });
  await until(() => under(slow.id).length >= 2 && sentUnder(slow.id).length >= 1, 30_000);
  check("a task still being worked on when the town is restarted is followed to its end", JSON.stringify(under(slow.id).slice(1)) === JSON.stringify(["✅ 做完了：改好了「慢慢做一份报告」"]), under(slow.id));
  check("…and what it left is handed back, once", JSON.stringify(sentUnder(slow.id).map((each) => each.file)) === JSON.stringify(["./报告.md"]), sentUnder(slow.id));
  settled.set(taken.findIndex((event) => event.id === `feishu-${second.id}`) + 1, "done");
  await until(() => under(second.id).length >= 3, 30_000);
  check("a question pointed to before the restart is not pointed to again, and what its answer led to is still said", JSON.stringify(under(second.id).slice(1)) === JSON.stringify(["它停下来等你拍板：「选哪个？」。在下面的卡片上选一个，或者直接写回答。", "✅ 做完了：按你选的做了"]), under(second.id));
  const again = replies().filter((each) => Number(each.reply.slice("om_test".length)) <= old);
  check("messages dealt with before the restart are not dealt with again when they are delivered again", again.length === saidBefore && taken.length === takenBefore + 4, { saidBefore, saidNow: again.length, takenBefore, takenNow: taken.length });
  check("folders the town made long ago are cleared away; newer ones, and ones it didn't make, are left", !existsSync(path.join(work1, ".town-inbox", "20200101-000000-abcd")) && !existsSync(path.join(work1, ".town-outbox", "20200101-000000-abcd")) && existsSync(path.join(work1, ".town-outbox", "不是小镇建的")) && existsSync(slowBox) && existsSync(box), outboxes(work1));
} finally {
  town.kill();
  hub.close();
  await wait(300);
  rmSync(base, { recursive: true, force: true });
}
const failed = results.some((line) => line.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(failed ? "\nSOME FAILED" : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
