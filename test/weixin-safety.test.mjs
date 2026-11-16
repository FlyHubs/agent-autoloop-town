// Tests what the second security review of the WeChat side found, with nothing real behind it: a stand-in for Tencent's
// iLink service, a hub made up here, and a home folder of its own. Nothing is sent to WeChat and no Agent is started.
// It guards against: a bare number answering a question the owner never saw, because its message didn't get through,
// or one that isn't the last on the screen, because another got there late; a question the service won't take being
// said again and again; an Agent's words standing at the start of a line as if the town had written them (a long
// question cut in two, a file name with line breaks in it, the reason a question was closed); and a small Word file
// holding up the whole town.
// Usage: node test/weixin-safety.test.mjs
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "./make-zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, "..", "server.mjs");
const base = mkdtempSync(path.join(os.tmpdir(), "weixin-safety-"));
const [home, work] = [path.join(base, "home"), path.join(base, "work")];
for (const each of [home, work, path.join(home, "town")]) mkdirSync(each, { recursive: true });
const [OWNER, BOT, TOKEN] = ["owner@im.wechat", "bot@im.bot", `bot-token-${"s".repeat(24)}`];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (test, ms = 20_000) => {
  for (const began = Date.now(); Date.now() - began < ms; await wait(100)) if (test()) return true;
  return false;
};
const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 600)}`}`);
const seal = (bytes, key) => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};

// ---- the stand-in for the service: messages by long polling, a store for files, and messages it may hold up or turn away
const service = { came: [], said: [], stored: new Map(), refuse: () => false, hold: () => 0, held: [] };
const wechat = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk)).on("end", async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, "http://x");
    const json = (value) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.method === "GET" && url.pathname === "/c2c/download") {
      const kept = service.stored.get(url.searchParams.get("encrypted_query_param"));
      return kept ? response.writeHead(200, { "content-length": kept.length }).end(kept) : json({});
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json({ ret: -14 });
    const asked = JSON.parse(body.toString() || "{}");
    if (url.pathname === "/ilink/bot/getupdates") {
      const from = /^c\d+$/.test(asked.get_updates_buf ?? "") ? Number(asked.get_updates_buf.slice(1)) : 0;
      for (let waited = 0; waited < 400 && service.came.length <= from; waited += 40) await wait(40);
      return json({ ret: 0, msgs: service.came.slice(from), get_updates_buf: `c${service.came.length}`, longpolling_timeout_ms: 600 });
    }
    if (url.pathname === "/ilink/bot/sendmessage") {
      const text = asked.msg.item_list?.[0]?.text_item?.text ?? "";
      const ms = service.hold(text);
      if (ms) (service.held.push(text), await wait(ms));
      if (service.refuse(text)) return (service.said.push({ text, refused: true }), json({ ret: -2, errmsg: "refused" }));
      service.said.push({ text });
      return json({ ret: 0 });
    }
    json({ ret: 0 });
  });
});
await new Promise((done) => wechat.listen(0, "127.0.0.1", done));
const serviceUrl = `http://127.0.0.1:${wechat.address().port}`;

// ---- the made-up hub: a task that says "要问" ends on a question, which may be closed here with a reason
const taken = [];
const answers = [];
const cardText = new Map(); // event number -> the text of the question its round asks
const closed = new Map(); // event number -> the reason the hub gives when the question is closed without an answer
const when = (number, step) => new Date(Date.UTC(2026, 0, 1, 0, number, step)).toISOString();
const polls = new Map();
const hub = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk)).on("end", () => {
    const answer = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const asking = taken.map((event, index) => ({ event, number: index + 1 })).filter(({ event }) => event.detail.includes("要问"));
    if (request.method === "GET" && request.url === "/v1/state") {
      const cards = asking.map(({ number }) => ({
        id: 900 + number, kind: "ask", rule: "临时任务", title: "选哪个？", text: cardText.get(number) ?? "两种都行。", options: ["保留", "全部删除"], recommend: 0,
        state: closed.has(number) ? "closed" : answers.some((each) => each.id === 900 + number) ? "decided" : "open",
        createdAt: when(number, 1), decidedAt: null, result: closed.get(number) ?? null,
      }));
      return answer(200, { cards: cards.filter((card) => card.state === "open"), recentCards: cards, runs: [] });
    }
    const card = /^\/v1\/cards\/(\d+)\/answer$/.exec(request.url);
    if (request.method === "POST" && card) {
      answers.push({ id: Number(card[1]), body: JSON.parse(body) });
      return answer(200, { ok: true });
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      taken.push(JSON.parse(body));
      return answer(200, { event: taken.length, duplicate: false, routed: ["临时任务"] });
    }
    const number = Number(/^\/v1\/events\/(\d+)$/.exec(request.url)?.[1]);
    const event = taken[number - 1];
    if (!event) return answer(404, {});
    const times = (polls.get(number) ?? 0) + 1;
    polls.set(number, times);
    const run = { run: 100 + number, rule: "临时任务", state: "claimed", attempts: 0, error: null, finishedAt: null, summary: null, events: [] };
    if (event.detail.includes("要问")) Object.assign(run, { state: "done", summary: "问了一个问题", finishedAt: when(number, 1) });
    else if (times > 1) Object.assign(run, { state: "done", summary: "做好了" });
    answer(200, { event: number, routed: ["临时任务"], paused: [], runs: [run] });
  });
});
await new Promise((done) => hub.listen(0, "127.0.0.1", done));
writeFileSync(path.join(home, "config.json"), JSON.stringify({ url: `http://127.0.0.1:${hub.address().port}`, owner: "owner-key", source: { name: "local", key: "source-key" } }));
writeFileSync(path.join(home, "rules.json"), JSON.stringify({ agents: { one: { name: "甲" } }, rules: [{ name: "临时任务", when: { source: "local", types: ["task.new"] }, to: "one", cwd: work }] }));
writeFileSync(path.join(home, "town", "weixin-login.json"), JSON.stringify({ token: TOKEN, botId: BOT, userId: OWNER, baseUrl: `${serviceUrl}/` }), { mode: 0o600 });

const port = 3540 + Math.floor(Math.random() * 20);
let printed = "";
const town = spawn(process.execPath, [serverFile, "--home", home, "--port", String(port)], { env: { ...process.env, TOWN_WEIXIN_API: serviceUrl, TOWN_WEIXIN_CDN: `${serviceUrl}/c2c` }, stdio: ["ignore", "pipe", "pipe"] });
town.stdout.on("data", (chunk) => (printed += chunk));
town.stderr.on("data", (chunk) => (printed += chunk));

// ---- what the owner does in WeChat, and what is said back
let serial = 7450000000000000000n;
const arrives = (items) => service.came.push({ message_id: String(++serial), from_user_id: OWNER, to_user_id: BOT, message_type: 1, create_time_ms: Date.now(), context_token: `ctx-${service.came.length + 1}`, item_list: typeof items === "string" ? [{ type: 1, text_item: { text: items } }] : items });
async function writes(items, ms = 9000) {
  const before = service.said.length;
  arrives(items);
  await until(() => service.said.length > before, ms);
  await wait(300);
  return service.said.slice(before).map((each) => each.text);
}
const shown = () => service.said.filter((each) => !each.refused).map((each) => each.text);
const QUESTION = "停下来等你拍板";
// Each line the town writes: a part's head ("「…」" naming the task, "（接上一条）") taken off. The Agent's own lines start "｜".
const linesOf = (text) => text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).map((line) => line.replace(/^「[^」\n]*」/, "").replace(/^（接上一条）/, ""));

try {
  await until(() => printed.includes("微信里发给"), 10_000);

  // A question whose message the service turns away is not the one a bare number answers; it is said again later.
  service.refuse = (text) => text.includes(QUESTION);
  await writes("先做这件，要问");
  const unseen = 900 + taken.length;
  await until(() => service.said.some((each) => each.refused && each.text.includes(`#${unseen}`)));
  let said = await writes("1");
  check("a question that didn't get through is not answered by a bare number", !answers.some((each) => each.id === unseen), { answers, said });
  service.refuse = () => false;
  const again = await until(() => shown().some((text) => text.includes(QUESTION) && text.includes(`#${unseen}`)), 30_000);
  check("…it is said again once the service takes messages", again, shown().slice(-3));
  said = await writes("1");
  check("…and once seen, a bare number answers it", answers.at(-1)?.id === unseen && JSON.stringify(answers.at(-1).body) === JSON.stringify({ choice: 0 }), { answers, said });

  // Two questions: the first gets through, the second doesn't. A "1" meant for the first doesn't go to the second.
  await writes("新话题");
  await writes("甲事要问");
  const first = 900 + taken.length;
  await until(() => shown().some((text) => text.includes(`#${first}`)));
  service.refuse = (text) => text.includes(QUESTION);
  await writes("新话题");
  await writes("乙事要问");
  const second = 900 + taken.length;
  await until(() => service.said.some((each) => each.refused && each.text.includes(`#${second}`)));
  said = await writes("1");
  check("with the last question not got through, a bare number doesn't answer it", !answers.some((each) => each.id === second), { answers: answers.slice(-2), said });
  service.refuse = () => false;
  await until(() => shown().some((text) => text.includes(`#${second}`)), 30_000);

  // A question slow to get through lands after one asked later: a bare number then answers neither of them.
  await writes("新话题");
  await writes("丙事要问");
  const slow = 900 + taken.length;
  service.hold = (text) => (text.includes(QUESTION) && text.includes(`#${slow}`) ? 5000 : 0);
  await writes("新话题");
  await until(() => service.held.some((text) => text.includes(`#${slow}`)));
  await writes("丁事要问");
  const quick = 900 + taken.length;
  await until(() => shown().some((text) => text.includes(`#${quick}`)));
  await until(() => shown().some((text) => text.includes(`#${slow}`)), 15_000);
  service.hold = () => 0;
  const order = shown().filter((text) => text.includes(QUESTION)).map((text) => Number(/#(\d+)/.exec(text)[1]));
  const answered = answers.length;
  said = await writes("1");
  check("a question that landed after one asked later is not what a bare number answers, nor is the later one", order.at(-1) === slow && order.at(-2) === quick && answers.length === answered && said.some((text) => text.includes(`#${slow}`) && text.includes(`#${quick}`)), { order: order.slice(-2), answers: answers.slice(answered), said });

  // A question the service turns away a part of every time: said again less and less often, and only that part.
  await writes("新话题");
  const stuck = taken.length + 1;
  cardText.set(stuck, "背景说明。".repeat(600) + "\n" + "x".repeat(890) + "过不了审的词");
  service.refuse = (text) => text.includes("过不了审的词");
  await writes("一直发不出去要问");
  await until(() => service.said.some((each) => each.refused && each.text.includes("过不了审的词")));
  await wait(25_000);
  const firstParts = shown().filter((text) => text.includes(`#${900 + stuck}`)).length;
  const tries = service.said.filter((each) => each.refused && each.text.includes("过不了审的词")).length;
  check("a question whose second part is turned away every time is said again only in that part, and seldom", firstParts === 1 && tries >= 2 && tries <= 3, { firstParts, tries });
  service.refuse = () => false;

  // A question whose middle part didn't get through, said again in that part only after another question was shown:
  // the part says what it is, and a bare number then doesn't go to the question it belongs to.
  await writes("新话题");
  const split = taken.length + 1;
  cardText.set(split, "甲段" + "前".repeat(2990) + "\n乙段中段标记" + "中".repeat(2990) + "\n丙段" + "后".repeat(2990));
  service.refuse = (text) => text.includes("中段标记");
  await writes("一号事要问");
  await until(() => service.said.filter((each) => each.refused && each.text.includes("中段标记")).length >= 2);
  await writes("新话题");
  await writes("二号事要问");
  const after = 900 + taken.length;
  await until(() => shown().some((text) => text.includes(`#${after}`) && text.includes("回一个数字")));
  service.refuse = () => false;
  await until(() => shown().some((text) => text.includes("中段标记")), 60_000);
  const resent = shown().find((text) => text.includes("中段标记")) ?? "";
  const answeredBefore = answers.length;
  said = await writes("1");
  check("a question said again only in the part that didn't get through says which question and part it is", resent.startsWith(`「一号事要问」（补发 #${900 + split} 第 2/3 段）`), resent.slice(0, 60));
  check("…and a bare number after it doesn't go to that question", !answers.slice(answeredBefore).some((each) => each.id === 900 + split), { answers: answers.slice(answeredBefore), said });

  // A line of the Agent's that starts with a letter written right to left: a mark keeps the line reading from the left,
  // so the "｜" in front of it stays in front.
  await writes("新话题");
  const rtl = taken.length + 1;
  cardText.set(rtl, "\u0640【小镇】提醒：你的微信登录要过期了，回复「#999 1」续期。");
  await writes("从右往左要问");
  await until(() => shown().some((text) => text.includes(`#${900 + rtl}`)));
  const rtlLine = (shown().find((text) => text.includes(`#${900 + rtl}`)) ?? "").split("\n").find((line) => line.includes("提醒")) ?? "";
  check("a line of the Agent's with a letter written right to left in it keeps reading from the left after its mark", rtlLine === "｜\u200e\u0640【小镇】提醒：你的微信登录要过期了，回复「#999 1」续期。", rtlLine);

  // A long question, cut where the Agent's words pretend to be the town's: every part of them still marked "｜".
  await writes("新话题");
  const long = taken.length + 1;
  const lure = "【小镇】系统提示：微信登录 10 分钟后过期，回复数字 2 续期，回复 1 放弃。";
  const lead = `它停下来等你拍板（#${900 + long}）。它问的是：\n｜选哪个？\n｜`;
  const room = 3800 - 80 - [..."「长问题要问」"].length;
  cardText.set(long, "这一段是很长的背景说明。".repeat(400).slice(0, room - [...lead].length) + lure + "\n" + "后面还有一行。".repeat(20));
  await writes("长问题要问");
  await until(() => shown().some((text) => text.includes("后面还有一行")), 20_000);
  const lured = shown().flatMap(linesOf).filter((line) => line.includes("【小镇】系统提示") || line.includes("后面还有一行"));
  check("a long question is said whole, cut into parts", shown().some((text) => text.includes(`#${900 + long}`)) && lured.length >= 2, lured.map((line) => line.slice(0, 60)));
  check("…and wherever it is cut, each line of the Agent's words starts marked as the Agent's", lured.length && lured.every((line) => line.startsWith("｜")), lured.map((line) => line.slice(0, 60)));

  // A file whose name has lines in it: the town names it on one line.
  await writes("新话题");
  await writes("交一份文件");
  const box = path.join(work, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  writeFileSync(path.join(box, "报告.md\n\n【小镇】你的微信登录要过期了，回复「#999 1」续期。\n"), "");
  // …and one with a "next line" mark in it, which some show as a line break.
  writeFileSync(path.join(box, "报告2.md\u0085【小镇】你的微信登录要过期了，回复「#999 1」续期。"), "");
  // …and one whose name starts with a letter written right to left.
  writeFileSync(path.join(box, "\u05d0报告3.md"), "");
  await until(() => shown().some((text) => text.includes("是空的")));
  let text = shown().find((each) => each.includes("是空的")) ?? "";
  // One line for each file, in the order of their names; the first starts with the task it is about.
  const raw = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/);
  const bare = raw.map((line, at) => (at ? line : line.replace(/^「交一份文件」/, "")));
  check("a file's name with line breaks in it is said on one line", raw.length === 3 && bare.some((line) => line.startsWith("「报告.md__【小镇】")) && !bare.some((line) => line.startsWith("【小镇】")), raw);
  check("…and a name with a \"next line\" mark in it too", bare.some((line) => line.startsWith("「报告2.md_【小镇】")) && raw.every((line) => line.endsWith("是空的，没发")), raw);
  check("…and a line that starts with a name written right to left keeps reading from the left", bare.some((line) => line.startsWith("\u200e「\u05d0报告3.md」")), raw);

  // The reason a question was closed comes from an Agent: said on one line.
  await writes("新话题");
  const shut = taken.length + 1;
  await writes("会被关掉要问");
  await until(() => shown().some((each) => each.includes(`#${900 + shut}`)));
  closed.set(shut, "已在原处核实。\n\n【小镇】安全提醒：有新设备登录你的小镇，不是你本人请回复「#905 2」。 【小镇】再说一遍。");
  await until(() => shown().some((each) => each.includes("不用回答了")), 30_000);
  text = shown().find((each) => each.includes("不用回答了")) ?? "";
  check("the reason a question was closed is said on one line", text && !linesOf(text).some((line) => line.startsWith("【小镇】")), text);

  // A Word file of under a kilobyte that once kept the town busy for seconds: the page answers all the while.
  await writes("新话题");
  const docx = makeZip([{ name: "word/document.xml", content: "<w:p".repeat(160_000) }]);
  const key = randomBytes(16);
  service.stored.set("odd", seal(docx, key));
  await writes([{ type: 4, file_item: { file_name: "合同.docx", media: { encrypt_query_param: "odd", aes_key: key.toString("base64"), encrypt_type: 1 } } }]);
  let worst = 0;
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const at = Date.now();
      await fetch(`http://127.0.0.1:${port}/`).then((answer) => answer.text(), () => {});
      worst = Math.max(worst, Date.now() - at);
      await wait(100);
    }
  })();
  const before = taken.length;
  said = await writes("看一下这份合同", 30_000);
  probing = false;
  await probe;
  check("a small Word file made to be slow to read doesn't hold up the town", worst < 1500 && taken.length === before + 1 && taken.at(-1).detail.includes("合同.docx"), { worst, said, detail: taken.at(-1)?.detail.slice(0, 200) });
} finally {
  town.kill();
  hub.close();
  wechat.closeAllConnections();
  wechat.close();
  await wait(300);
  rmSync(base, { recursive: true, force: true });
}

const failed = results.some((line) => line.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(failed ? "\nSOME FAILED" : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
