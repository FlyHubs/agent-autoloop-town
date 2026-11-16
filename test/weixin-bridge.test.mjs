// Tests the town's WeChat side with nothing real behind it: a stand-in here for Tencent's iLink service and its
// storage, a hub made up here, and a home folder of its own. Nothing is sent to WeChat and no Agent is started.
// It guards against: anyone but the account that scanned the code starting work or answering a question; a login kept
// where others can read it, or shown in what is printed; a message dealt with twice, or lost, over a restart; a picture
// or file that doesn't come out as it went in; an answer reaching the hub for a question that wasn't asked here; and a
// login gone stale being hammered at.
// Usage: node test/weixin-bridge.test.mjs
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qrMatrix } from "../qr.mjs";
import { sampleDocx } from "./make-zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, "..", "server.mjs");
const base = mkdtempSync(path.join(os.tmpdir(), "weixin-check-"));
const [home, work] = [path.join(base, "home"), path.join(base, "work")];
for (const each of [home, work]) mkdirSync(each);
const [OWNER, BOT, TOKEN] = ["owner-o9cq80@im.wechat", "bot-7f3a@im.bot", `bot-token-${"s".repeat(24)}`];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (test, ms = 20_000) => {
  for (const began = Date.now(); Date.now() - began < ms; await wait(150)) if (test()) return true;
  return false;
};
const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 500)}`}`);
const seal = (bytes, key) => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};
const unseal = (bytes, key) => {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
};

// ---- the stand-in for the service: binding, messages by long polling, and storage for pictures and files
const service = { asked: [], scans: [], polls: [], said: [], places: [], uploads: 0, stored: new Map(), came: [], expired: false, instant: false, refuse: 0, failUpload: 0 };
let serviceUrl = "";
let scanStep = 0;
const wechat = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk)).on("end", async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, "http://stand-in");
    const json = (value, status = 200, headers = {}) => response.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof value === "string" ? value : JSON.stringify(value));
    const given = () => JSON.parse(body.toString("utf8") || "{}");
    if (url.pathname === "/ilink/bot/get_bot_qrcode") {
      service.asked.push({ headers: request.headers, body: given(), type: url.searchParams.get("bot_type") });
      return json({ qrcode: `qr-${service.asked.length}`, qrcode_img_content: `https://liteapp.weixin.qq.com/q/stand-in?qrcode=qr-${service.asked.length}&bot_type=3` });
    }
    if (url.pathname === "/ilink/bot/get_qrcode_status") {
      const pin = url.searchParams.get("verify_code");
      service.scans.push({ headers: request.headers, code: url.searchParams.get("qrcode"), pin });
      // How a binding goes: nothing yet; then the phone shows digits, and they have to be the right ones; then confirmed.
      if (scanStep === 0) return (scanStep++, json({ status: "wait" }));
      if (scanStep === 1) return pin === "246810" ? (scanStep++, json({ status: "scaned" })) : json({ status: "need_verifycode" });
      return json({ status: "confirmed", bot_token: TOKEN, ilink_bot_id: BOT, ilink_user_id: OWNER, baseurl: serviceUrl });
    }
    if (request.method === "POST" && (url.pathname === "/store/put" || url.pathname === "/c2c/upload")) {
      service.uploads++;
      if (service.failUpload > 0) return (service.failUpload--, json({}, 500));
      const name = `d-${url.searchParams.get("p") ?? url.searchParams.get("encrypted_query_param")}`;
      service.stored.set(name, { bytes: body, filekey: url.searchParams.get("filekey"), type: request.headers["content-type"] });
      return json({}, 200, { "x-encrypted-param": name });
    }
    // Storage that sends the asker on somewhere else, and storage that never says how much is coming.
    if (request.method === "GET" && url.pathname === "/store/moved") return response.writeHead(302, { location: `${serviceUrl}/store/get?p=${url.searchParams.get("p")}` }).end();
    if (request.method === "GET" && url.pathname === "/store/endless") {
      response.on("error", () => {});
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const lump = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const more = () => {
        while (sent < 24 && !response.destroyed) if ((sent++, !response.write(lump))) return void response.once("drain", more);
        response.end();
      };
      return more();
    }
    if (request.method === "GET" && (url.pathname === "/c2c/download" || url.pathname === "/store/get")) {
      const kept = service.stored.get(url.searchParams.get("encrypted_query_param") ?? url.searchParams.get("p"));
      return kept ? response.writeHead(200, { "content-type": "application/octet-stream", "content-length": kept.bytes.length }).end(kept.bytes) : json({}, 404);
    }
    if (!url.pathname.startsWith("/ilink/bot/")) return json({}, 404);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json({ ret: -14, errmsg: "not logged in" });
    if (url.pathname === "/ilink/bot/getupdates") {
      const asked = given();
      service.polls.push({ cursor: asked.get_updates_buf, info: asked.base_info, headers: request.headers });
      // A login gone stale, said the way the service may write it; and an answer that comes at once with nothing in it.
      if (service.expired) return json({ ret: "-14", errmsg: "session timeout" });
      if (service.instant) return json({ ret: 0, msgs: [], get_updates_buf: asked.get_updates_buf, longpolling_timeout_ms: 5_000_000_000 });
      // The cursor says how many messages have been read: whatever came after is handed over, at once or when it comes.
      const from = /^c\d+$/.test(asked.get_updates_buf ?? "") ? Number(asked.get_updates_buf.slice(1)) : 0;
      for (let waited = 0; waited < 400 && service.came.length <= from; waited += 40) await wait(40);
      // The service writes a message's number as a number, longer than JavaScript keeps whole.
      return json(JSON.stringify({ ret: 0, msgs: service.came.slice(from), get_updates_buf: `c${service.came.length}`, longpolling_timeout_ms: 600 }).replace(/"message_id":"(\d+)"/g, '"message_id":$1'));
    }
    if (url.pathname === "/ilink/bot/sendmessage") {
      const asked = given();
      service.said.push({ ...asked.msg, info: asked.base_info, auth: request.headers.authorization });
      return service.refuse > 0 ? (service.refuse--, json({ ret: -2, errmsg: "busy" })) : json({ ret: 0, errmsg: "" });
    }
    if (url.pathname === "/ilink/bot/getuploadurl") {
      service.places.push(given());
      const count = service.places.length;
      // Both ways the service may say where to put a thing: a whole address, or a part of one to be built on.
      return json(count % 2 ? { upload_full_url: `${serviceUrl}/store/put?p=u${count}` } : { upload_param: `u${count}` });
    }
    json({}, 404);
  });
});
await new Promise((done) => wechat.listen(0, "127.0.0.1", done));
serviceUrl = `http://127.0.0.1:${wechat.address().port}`;

// ---- the made-up hub: takes events and says how each one's round goes; a task that says so ends on a question
const taken = [];
const askedAfter = new Map();
const answers = [];
const when = (number, step) => new Date(Date.UTC(2026, 0, 1, 0, number, step)).toISOString();
const OPTIONS = ["快的", "稳的"];
const hub = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk)).on("end", () => {
    const answer = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const asking = taken.map((event, index) => ({ event, number: index + 1 })).filter(({ event }) => event.detail.includes("要问"));
    const answerTo = (number) => answers.find((each) => each.id === 900 + number);
    if (request.method === "GET" && request.url === "/v1/state") {
      if (request.headers.authorization !== "Bearer owner-key") return answer(401, {});
      const cards = asking.map(({ number }) => ({ id: 900 + number, kind: "ask", rule: "临时任务", title: "选哪个？", text: "两种做法都行。", options: taken[number - 1].detail.includes("没有选项") ? [] : OPTIONS, recommend: taken[number - 1].detail.includes("没有选项") ? null : 1, state: answerTo(number) ? "done" : "open", createdAt: when(number, 1), decidedAt: answerTo(number) ? when(number, 2) : null, result: answerTo(number) ? "按你说的做了" : null }));
      const runs = asking.filter(({ number }) => answerTo(number)).map(({ number }) => ({ id: 200 + number, rule: "临时任务", state: "done", createdAt: when(number, 2), finishedAt: when(number, 3), summary: `按你说的做了：${answerTo(number).body.text ?? OPTIONS[answerTo(number).body.choice]}`, events: [{ type: "card.answered" }] }));
      return answer(200, { cards: cards.filter((card) => card.state === "open"), recentCards: cards, runs });
    }
    const card = /^\/v1\/cards\/(\d+)\/answer$/.exec(request.url);
    if (request.method === "POST" && card) {
      if (request.headers.authorization !== "Bearer owner-key") return answer(401, { error: "不是本人" });
      if (!asking.some(({ number }) => 900 + number === Number(card[1])) || answers.some((each) => each.id === Number(card[1]))) return answer(409, { error: "这张卡片不在等回答" });
      answers.push({ id: Number(card[1]), body: JSON.parse(body) });
      return answer(200, { ok: true });
    }
    if (request.headers.authorization !== "Bearer source-key") return answer(401, {});
    if (request.method === "POST" && request.url === "/v1/events") {
      const event = JSON.parse(body);
      const duplicate = taken.some((each) => each.id === event.id);
      if (!duplicate) taken.push(event);
      return answer(200, { event: taken.findIndex((each) => each.id === event.id) + 1, duplicate, routed: duplicate ? [] : ["临时任务"] });
    }
    const number = Number(/^\/v1\/events\/(\d+)$/.exec(request.url)?.[1]);
    const event = taken[number - 1];
    if (request.method !== "GET" || !event) return answer(404, {});
    const times = (askedAfter.get(number) ?? 0) + 1;
    askedAfter.set(number, times);
    const run = { run: 100 + number, rule: "临时任务", state: "claimed", attempts: 0, error: null, finishedAt: null, summary: null, events: [] };
    if (event.detail.includes("要问")) Object.assign(run, { state: "done", summary: "问了一个问题", finishedAt: when(number, 1) });
    else if (event.detail.includes("慢慢做") && times <= 3) Object.assign(run, { state: "claimed" });
    else if (times > 1) Object.assign(run, { state: "done", summary: `改好了「${event.detail.split("\n")[0]}」` });
    answer(200, { event: number, routed: [run.rule], paused: [], runs: [run] });
  });
});
await new Promise((done) => hub.listen(0, "127.0.0.1", done));
writeFileSync(path.join(home, "config.json"), JSON.stringify({ url: `http://127.0.0.1:${hub.address().port}`, owner: "owner-key", source: { name: "local", key: "source-key" } }));
writeFileSync(path.join(home, "rules.json"), JSON.stringify({ agents: { one: { name: "甲", use: "claude" } }, rules: [{ name: "临时任务", when: { source: "local", types: ["task.new"] }, to: "one", cwd: work, parallel: 2, resume: true }] }));

const env = { ...process.env, TOWN_WEIXIN_API: serviceUrl, TOWN_WEIXIN_CDN: `${serviceUrl}/c2c` };
const port = 3500 + Math.floor(Math.random() * 20);
let printed = "";
function start() {
  const child = spawn(process.execPath, [serverFile, "--home", home, "--port", String(port), "--chat-idle", "30"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => (printed += chunk));
  child.stderr.on("data", (chunk) => (printed += chunk));
  return child;
}
const stop = (child) => new Promise((done) => (child.once("exit", done), child.kill()));

// ---- what the owner does in WeChat, and what is said back
let serial = 7450000000000000000n; // past what a double keeps whole: two of these next to each other must stay two
const words = (text) => [{ type: 1, text_item: { text } }];
function arrives(given) {
  const id = String(given.message_id ?? ++serial);
  const message = { from_user_id: OWNER, to_user_id: BOT, message_type: 1, message_state: 2, create_time_ms: Date.now(), context_token: `ctx-${service.came.length + 1}`, ...given, message_id: id };
  service.came.push(message);
  return message;
}
const textOf = (message) => message.item_list?.find((item) => item.type === 1)?.text_item?.text ?? "";
const says = () => service.said.map(textOf).filter(Boolean);
/** Something is written in WeChat. Says what was said back first, having waited long enough to know if nothing was. */
async function writes(items, { silent = false, ...given } = {}) {
  const before = service.said.length;
  const message = arrives({ item_list: typeof items === "string" ? words(items) : items, ...given });
  if (silent) await wait(1600);
  else await until(() => service.said.length > before, 9000);
  await wait(150);
  return { id: message.message_id, context: message.context_token, said: service.said.slice(before).map(textOf).filter(Boolean), sent: service.said.slice(before) };
}
/** Waits until something said starts by naming this task and holds these words. */
const told = (label, what, ms = 20_000) => until(() => says().some((text) => text.startsWith(`「${label}」`) && text.includes(what)), ms);
const inbox = () => (existsSync(path.join(work, ".town-inbox")) ? readdirSync(path.join(work, ".town-inbox")).filter((name) => name !== ".gitignore").flatMap((stamp) => readdirSync(path.join(work, ".town-inbox", stamp)).map((name) => path.join(work, ".town-inbox", stamp, name))) : []);

let town = null;
try {
  // A code a phone can read is the way in, so the making of it is checked against what a real reader was seen to read.
  const print = (text) => createHash("sha256").update(qrMatrix(text).map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);
  check("the code made for a text is the one a phone's reader was seen to read back", print("hello, world") === "dc4097ab64cea969" && print("https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=8f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e&bot_type=3") === "5002d859a08a2d5c" && qrMatrix("y".repeat(272)) === null, [print("hello, world"), print("https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=8f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e&bot_type=3")]);

  // ---- binding a WeChat account
  let shown = "";
  const binding = spawn(process.execPath, [serverFile, "--home", home, "--weixin-login", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  binding.stdout.on("data", (chunk) => (shown += chunk));
  binding.stderr.on("data", (chunk) => (shown += chunk));
  const bound = new Promise((done) => binding.once("exit", done));
  const pin = (digits) => new Promise((done) => spawn(process.execPath, [serverFile, "--home", home, "--weixin-pin", digits], { env, stdio: "ignore" }).once("exit", done));
  await until(() => shown.includes("手机微信上显示了一串数字"), 15_000);
  const page = /(\/\S*weixin-login\.html)/.exec(shown)?.[1] ?? "";
  check("a code to scan is shown in the terminal, and as a page that only the owner can read and that runs nothing", /[█▀▄ ]{20,}/.test(shown) && existsSync(page) && (statSync(page).mode & 0o077) === 0 && readFileSync(page, "utf8").includes("<svg") && !readFileSync(page, "utf8").includes("<script"), { shown: shown.slice(-300), page });
  await pin("111111");
  await until(() => shown.includes("不对"), 10_000);
  check("digits the phone didn't show are asked for again", shown.includes("不对"), shown.slice(-200));
  await pin("246810");
  const code = await Promise.race([bound, wait(15_000).then(() => "still going")]);
  const loginFile = path.join(home, "town", "weixin-login.json");
  const kept = existsSync(loginFile) ? JSON.parse(readFileSync(loginFile, "utf8")) : {};
  check("once confirmed on the phone, what the service handed over is kept where only the owner reads", code === 0 && kept.token === TOKEN && kept.userId === OWNER && kept.baseUrl === `${serviceUrl}/` && (statSync(loginFile).mode & 0o077) === 0, { code, keys: Object.keys(kept), shown: shown.slice(-300) });
  check("the token is never printed, and the digits are not left lying about", !shown.includes(TOKEN) && !existsSync(path.join(home, "town", "weixin-pin")) && !existsSync(page), shown.slice(-200));
  check("the service is asked as Tencent's own client asks it: named, versioned, and with no login before there is one", service.asked.length === 1 && service.asked[0].type === "3" && service.asked[0].headers["ilink-app-id"] === "bot" && service.asked[0].headers["ilink-app-clientversion"] === String((2 << 16) | (4 << 8) | 10) && service.asked[0].headers.authorizationtype === "ilink_bot_token" && !service.asked[0].headers.authorization && Array.isArray(service.asked[0].body.local_token_list) && service.scans.every((each) => !each.headers.authorization && each.code === "qr-1"), { asked: service.asked, scans: service.scans.length });
  check("the digits go with the question after the one that asked for them, and only then", JSON.stringify(service.scans.filter((each) => each.pin).map((each) => each.pin)) === JSON.stringify(["111111", "246810"]) && !service.scans[0].pin && !service.scans[1].pin, service.scans.map((each) => each.pin));

  // ---- hearing
  town = start();
  await until(() => printed.includes("微信里发给"), 8000);
  check("the server says it is listening to WeChat", printed.includes("微信里发给") && !printed.includes(TOKEN), printed);
  let got = await writes("删库", { from_user_id: "someone-else@im.wechat", silent: true });
  check("words from another account start nothing and get no answer", taken.length === 0 && service.said.length === 0, { taken, said: says() });
  got = await writes("机器人自己说的", { message_type: 2, silent: true });
  got = await writes("群里说的", { group_id: "group-1", silent: true });
  check("what the bot said itself, and what was said in a group, start nothing", taken.length === 0 && service.said.length === 0, { taken, said: says() });

  const first = await writes("帮我整理一下 README");
  check("the owner's words become a task", taken.length === 1 && taken[0].type === "task.new" && taken[0].detail.startsWith("帮我整理一下 README") && taken[0].id === `weixin-${first.id}` && taken[0].subject === `weixin:${first.id}`, taken);
  check("…and are answered in the same chat: who it went to, and where the result will come", first.said[0] === "已派给「甲」（临时任务）。做完会在这里回你。", first.said);
  const reply = first.sent[0];
  check("what is said goes to the owner, with the token their message came with, as the bot, and names what is speaking", reply.to_user_id === OWNER && reply.context_token === first.context && reply.auth === `Bearer ${TOKEN}` && reply.message_type === 2 && reply.message_state === 2 && /^town-[0-9a-f]{40}$/.test(reply.client_id) && /^2\.4\.10\//.test(reply.info.channel_version) && /^[A-Za-z]+\/[\d.]+$/.test(reply.info.bot_agent), reply);
  await told("帮我整理一下 README", "做完了");
  check("when its round is done that is said, naming the task, since nothing hangs under a message here", says().includes("「帮我整理一下 README」✅ 做完了：改好了「帮我整理一下 README」"), says());
  got = await writes("帮我整理一下 README", { message_id: first.id, silent: true });
  check("the same message handed over twice starts nothing more", taken.length === 1, taken.length);

  const [one, two] = [arrives({ item_list: words("挨着的两条里的第一条") }), arrives({ item_list: words("挨着的两条里的第二条") })];
  await until(() => taken.length === 3, 9000);
  check("two messages whose numbers differ only past what a double keeps are two tasks", taken.length === 3 && BigInt(two.message_id) - BigInt(one.message_id) === 1n && Number(one.message_id) === Number(two.message_id) && taken[1].id === `weixin-${one.message_id}` && taken[2].id === `weixin-${two.message_id}`, taken.map((event) => event.id));
  await told("挨着的两条里的第二条", "做完了");

  // ---- pictures and files coming in
  const picture = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(700)]);
  const pictureKey = randomBytes(16);
  service.stored.set("in-picture", { bytes: seal(picture, pictureKey) });
  got = await writes([{ type: 2, image_item: { aeskey: pictureKey.toString("hex"), media: { encrypt_query_param: "in-picture", encrypt_type: 1 } } }]);
  check("a picture on its own is fetched, unsealed, and waits; and says so", /^收到 1 个附件：图片-\d{6}\.jpg（704 B）。接着发文字/.test(got.said[0]) && taken.length === 3, got.said);
  const paper = Buffer.from("# 需求\n先把登录页做出来。\n");
  const paperKey = randomBytes(16);
  service.stored.set("in-paper", { bytes: seal(paper, paperKey) });
  got = await writes([{ type: 4, file_item: { file_name: "../../需求.md", len: String(paper.length), media: { full_url: `${serviceUrl}/store/get?p=in-paper`, aes_key: Buffer.from(paperKey.toString("hex")).toString("base64"), encrypt_type: 1 } } }]);
  check("a file waits with it, under its own name and no folders", /^收到 1 个附件：需求\.md（\d+ B）。接着发文字说要做什么，连同之前的共 2 个会随任务/.test(got.said[0]), got.said);
  got = await writes("把附件整理成清单");
  const landed = inbox();
  check("the next words carry both, and they lie in the working folder exactly as they were sent", taken.length === 4 && got.said[0] === "已交给「甲」接着做（临时任务，带着刚才的上下文，带 2 个附件）。做完会在这里回你。" && landed.length === 2 && landed.some((file) => readFileSync(file).equals(picture)) && landed.some((file) => path.basename(file) === "需求.md" && readFileSync(file).equals(paper)), { said: got.said, landed });
  service.stored.set("in-big", { bytes: seal(Buffer.alloc(21 * 1024 * 1024), paperKey) });
  got = await writes([{ type: 4, file_item: { file_name: "大文件.zip", media: { encrypt_query_param: "in-big", aes_key: paperKey.toString("base64"), encrypt_type: 1 } } }]);
  check("a file over the limit is turned away without being kept", got.said[0] === "「大文件.zip」没取下来：超过 20 MB", got.said);
  service.stored.set("in-cut", { bytes: seal(paper, paperKey).subarray(0, -3) });
  got = await writes([{ type: 4, file_item: { file_name: "打不开.bin", media: { encrypt_query_param: "in-cut", aes_key: paperKey.toString("base64"), encrypt_type: 1 } } }]);
  check("a file cut short on the way can't be unsealed, and says so", got.said[0] === "「打不开.bin」没取下来：取下来了，但解不开", got.said);
  got = await writes([{ type: 4, file_item: { file_name: "转走的.bin", media: { full_url: `${serviceUrl}/store/moved?p=in-paper`, aes_key: paperKey.toString("base64"), encrypt_type: 1 } } }]);
  check("a file whose address sends the asker on somewhere else is not followed there", got.said[0] === "「转走的.bin」没取下来：取不下来（连不上，或者被转到了别处）", got.said);
  got = await writes([{ type: 4, file_item: { file_name: "没说多大.bin", media: { full_url: `${serviceUrl}/store/endless`, aes_key: paperKey.toString("base64"), encrypt_type: 1 } } }]);
  check("a file that doesn't say how big it is is stopped at the limit all the same", got.said[0] === "「没说多大.bin」没取下来：超过 20 MB", got.said);
  const { weixin } = await import("../weixin.mjs");
  const refused = (api) => weixin({ api }).code([]).then(() => "asked", (error) => error.message);
  const [clear, local] = [await refused("http://example.com"), await refused("http://127.0.0.1:9")];
  check("the service is only ever asked over HTTPS: not in the clear, and not this machine unless a test has said so", clear === "不是 HTTPS 地址" && local === "不是 HTTPS 地址" && !process.env.TOWN_WEIXIN_API, [clear, local]);
  // A Word file can't be read as it is by an Agent that may only read files: its words come with it.
  const wordFile = sampleDocx();
  service.stored.set("in-report", { bytes: seal(wordFile, paperKey) });
  await writes([{ type: 4, file_item: { file_name: "调查报告.docx", len: String(wordFile.length), media: { encrypt_query_param: "in-report", aes_key: paperKey.toString("base64"), encrypt_type: 1 } } }]);
  await writes("新话题");
  got = await writes("读一下这个报告");
  const asText = /文字版：(\.town-inbox\/[^，]+\.txt)，读它就行/.exec(taken.at(-1).detail)?.[1];
  check("a Word file comes with a text copy of its words, and the task points the Agent to it", Boolean(asText) && readFileSync(path.join(work, asText), "utf8").includes("一中 （本部）\t92") && existsSync(path.join(work, asText.replace(/\.txt$/, ""))), { detail: taken.at(-1).detail.slice(0, 300) });
  await told("读一下这个报告", "做完了");
  const spokenBefore = taken.length;
  got = await writes([{ type: 3, voice_item: { text: "这是说出来的一件任务", playtime: 2100 } }]);
  check("what was spoken is taken by what WeChat heard in it", taken.length === spokenBefore + 1 && taken.at(-1).detail.startsWith("这是说出来的一件任务"), { said: got.said, last: taken.at(-1)?.detail });
  got = await writes([{ type: 3, voice_item: { playtime: 900 } }]);
  check("speech with no words heard in it is not guessed at", got.said[0] === "这条语音没有转成文字，我听不了：发文字、图片或文件。" && taken.length === spokenBefore + 1, got.said);
  await told("这是说出来的一件任务", "做完了");

  // ---- files going back
  service.failUpload = 1;
  const report = await writes("新话题");
  const asksFor = await writes("写一份周报文档");
  const box = path.join(work, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  const [doc, chart] = [Buffer.from("# 周报\n这一周做了三件事。\n"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(900)])];
  writeFileSync(path.join(box, "周报.md"), doc);
  writeFileSync(path.join(box, "图表.png"), chart);
  const media = () => service.said.filter((message) => message.item_list?.some((item) => item.type === 2 || item.type === 4));
  await until(() => media().length >= 2, 25_000);
  const sentBack = media().map((message) => message.item_list[0]);
  const [fileItem, imageItem] = [sentBack.find((item) => item.type === 4), sentBack.find((item) => item.type === 2)];
  const [filePlace, imagePlace] = [service.places.find((place) => place.media_type === 3), service.places.find((place) => place.media_type === 1)];
  const back = (item, place) => {
    const stored = service.stored.get((item?.file_item ?? item?.image_item)?.media?.encrypt_query_param);
    return stored && place ? { stored, bytes: unseal(stored.bytes, Buffer.from(place.aeskey, "hex")) } : null;
  };
  const [fileBack, imageBack] = [back(fileItem, filePlace), back(imageItem, imagePlace)];
  check("what the Agent left is sealed and stored as the service asks, and unseals to exactly what was left", fileBack?.bytes.equals(doc) && imageBack?.bytes.equals(chart) && filePlace.rawsize === doc.length && filePlace.rawfilemd5 === createHash("md5").update(doc).digest("hex") && filePlace.filesize === fileBack.stored.bytes.length && filePlace.no_need_thumb === true && filePlace.to_user_id === OWNER && [fileBack, imageBack].every((each) => each.stored.type === "application/octet-stream"), { filePlace, imagePlace, got: [Boolean(fileBack), Boolean(imageBack)] });
  check("…then pointed to by a message: a file by its name and size, a picture as a picture, each with its key", fileItem.file_item.file_name === "周报.md" && fileItem.file_item.len === String(doc.length) && fileItem.file_item.media.aes_key === Buffer.from(filePlace.aeskey).toString("base64") && fileItem.file_item.media.encrypt_type === 1 && imageItem.image_item.mid_size === imageBack.stored.bytes.length && imageItem.image_item.media.aes_key === Buffer.from(imagePlace.aeskey).toString("base64"), { fileItem, imageItem });
  check("a store that fails once is tried again, and where the service gives only part of an address the rest is built", service.uploads === 3 && [...service.stored.values()].some((each) => each.filekey && service.places.some((place) => place.filekey === each.filekey)), { uploads: service.uploads, places: service.places.length });
  check("everything said has a name of its own", new Set(service.said.map((message) => message.client_id)).size === service.said.length, service.said.map((message) => message.client_id));

  // ---- what the Agent has to say at more length than the one line the hub keeps
  await writes("新话题");
  await writes("说说这张图里有什么");
  const sayBox = path.join(work, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0]);
  const long = `图里有这些：\n${"一只猫趴在桌上。".repeat(700)}`;
  writeFileSync(path.join(sayBox, "回复.md"), `${long}\n`);
  const mediaBefore = media().length;
  const spoken = () => says().filter((text) => text.includes("一只猫趴在桌上"));
  await until(() => spoken().length >= 2, 25_000);
  await wait(800);
  const heads = spoken().map((text, at) => `「说说这张图里有什么」Agent 的回复（${at + 1}/${spoken().length}）：\n`);
  check("what the Agent wrote to the file for its reply is said as words, in as many messages as its length needs, each naming the task and marked as the Agent's", spoken().length === 2 && spoken().every((text, at) => text.startsWith(heads[at]) && [...text].length <= 3800) && spoken().map((text, at) => text.slice(heads[at].length)).join("") === long && media().length === mediaBefore, { parts: spoken().map((text) => [...text].length), starts: spoken().map((text) => text.slice(0, 30)), media: media().length - mediaBefore });

  // ---- a question, asked and answered in the chat
  await writes("新话题");
  await writes("这一件要问我");
  const cardId = 900 + taken.length;
  await told("这一件要问我", `#${cardId}`);
  const asked = says().find((text) => text.includes(`#${cardId}`)) ?? "";
  check("a question is written out: what the Agent asked set off as its own words, each choice numbered here, and how to answer", asked === `「这一件要问我」它停下来等你拍板（#${cardId}）。它问的是：\n｜选哪个？\n｜两种做法都行。\n可以选：\n1. 快的\n2. 稳的（它推荐）\n回一个数字就是选它；想说别的，回「#${cardId} 你的话」。`, asked);
  got = await writes("1", { from_user_id: "someone-else@im.wechat", silent: true });
  check("another account's number answers nothing", answers.length === 0, answers);
  got = await writes("3");
  check("a number that is no choice is not sent on", answers.length === 0 && got.said[0] === `「这一件要问我」的问题 #${cardId} 只有 2 个选项：回 1 到 2 之间的数字，或者回「#${cardId} 你的话」。`, got.said);
  const before = taken.length;
  got = await writes("２。");
  check("…and put right in the next message, in whatever digits the phone writes, it answers that question as the owner and is no task", answers.length === 1 && answers[0].id === cardId && JSON.stringify(answers[0].body) === JSON.stringify({ choice: 1 }) && taken.length === before && got.said[0] === `「这一件要问我」的问题 #${cardId}：选了「稳的」。它接着做，有结果在这里回你。`, { answers, said: got.said });
  got = await writes(`#${cardId} 1`);
  check("an answer to a question just answered is not taken a second time, nor for a task", answers.length === 1 && taken.length === before && got.said.some((text) => /没答成|已经不在等回答了/.test(text)), got.said);
  await told("这一件要问我", "按你说的做了：稳的");
  check("…and what the answer led to is said", says().includes("「这一件要问我」✅ 做完了：按你说的做了：稳的"), says().slice(-3));
  got = await writes("2");
  check("with nothing waiting, a bare number is neither an answer nor a task", answers.length === 1 && taken.length === before && got.said[0] === "现在没有在等你回答的问题。", got.said);
  got = await writes(`#${cardId} 还想补一句`);
  check("words for a question settled long since are told so, and are not taken for a new task", taken.length === before && got.said[0] === `#${cardId} 这个问题已经不在等回答了。`, got.said);

  // Words that begin with a number are words.
  await writes("新话题");
  await writes("这一件也要问我");
  const second = 900 + taken.length;
  await told("这一件也要问我", `#${second}`);
  got = await writes(`#${second} 1 个月以前的才删，别的都留着`);
  check("words after the question's number are the answer in the owner's own words, even when they begin with a number", answers.length === 2 && answers[1].id === second && JSON.stringify(answers[1].body) === JSON.stringify({ text: "1 个月以前的才删，别的都留着" }) && got.said.includes(`「这一件也要问我」的问题 #${second}：你的话交给它了。它接着做，有结果在这里回你。`), { answers, said: got.said });
  await told("这一件也要问我", "按你说的做了：1 个月以前的才删，别的都留着");

  // A question with nothing to choose from is answered by whatever is written: a number too.
  await writes("新话题");
  await writes("这一件要问我，没有选项");
  const open = 900 + taken.length;
  await told("这一件要问我，没有选项", `#${open}`);
  check("a question with nothing to choose from says how it is answered, and lists nothing", says().some((text) => text.includes(`（#${open}）`) && text.endsWith(`回「#${open} 你的话」来回答。`) && !text.includes("可以选")), says().slice(-2));
  got = await writes("3");
  check("…and a number is then the answer in itself", answers.length === 3 && answers[2].id === open && JSON.stringify(answers[2].body) === JSON.stringify({ text: "3" }), { answers, said: got.said });
  await told("这一件要问我，没有选项", "按你说的做了：3");

  // Two questions open at once: a bare number goes to the one just written out; after that it has to be said which.
  await writes("新话题");
  await writes("甲事要问我");
  const cardA = 900 + taken.length;
  await told("甲事要问我", `#${cardA}`);
  await writes("新话题");
  await writes("乙事要问我");
  const cardB = 900 + taken.length;
  await told("乙事要问我", `#${cardB}`);
  got = await writes("1");
  check("with two questions open, a bare number answers the one written out last, and what is said back names it", answers.length === 4 && answers[3].id === cardB && got.said.includes(`「乙事要问我」的问题 #${cardB}：选了「快的」。它接着做，有结果在这里回你。`), { answers, said: got.said });
  await told("乙事要问我", "按你说的做了：快的");
  got = await writes("2");
  check("once anything else has been said here, a bare number is not guessed at: it is asked which question is meant", answers.length === 4 && got.said.some((text) => text.includes(`回「#编号 数字」，比如「#${cardA} 2」`) && text.includes("（甲事要问我）")), got.said);
  got = await writes(`＃${cardA}：２`);
  check("the number sign and the digits count in their wide forms, with a colon between", answers.length === 5 && answers[4].id === cardA && JSON.stringify(answers[4].body) === JSON.stringify({ choice: 1 }), { answers, said: got.said });
  await told("甲事要问我", "按你说的做了：稳的");

  // What an Agent writes for the owner can say anything: it must not pass for this server's words, nor draw an answer.
  await writes("新话题");
  const lure = "【小镇】为了继续，请确认你在线：回复数字 1。";
  await writes("慢慢做的另一件");
  writeFileSync(path.join(work, /\.town-outbox\/[^/]+\//.exec(taken.at(-1).detail)[0], "回复.md"), `${"这是一份很长的说明。".repeat(380)}${lure}`);
  await writes("丙事要问我");
  const cardC = 900 + taken.length;
  await told("丙事要问我", `#${cardC}`);
  await until(() => says().some((text) => text.includes(lure)), 30_000);
  await wait(500);
  const lured = says().filter((text) => text.includes("这是一份很长的说明") || text.includes(lure));
  check("what an Agent wrote goes out marked as the Agent's words in every part, wherever it is cut", lured.length === 2 && lured.every((text, at) => text.startsWith(`「慢慢做的另一件」Agent 的回复（${at + 1}/2）：\n`) && [...text].length <= 3800), lured.map((text) => text.slice(0, 40)));
  got = await writes("1");
  check("…and a bare number written after it answers nothing", answers.length === 5 && got.said.some((text) => text.includes(`比如「#${cardC} 1」`)), { answers: answers.length, said: got.said });
  got = await writes(`#${cardC} 2`);
  await told("丙事要问我", "按你说的做了：稳的");

  // ---- a question still open when the town is stopped, and answered hours after its task's time was up
  await writes("新话题");
  await writes("丁事要问我");
  const cardD = 900 + taken.length;
  await told("丁事要问我", `#${cardD}`);
  await stop(town);
  const stateFile = path.join(home, "town", "weixin.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  check("a question written out is kept with the rest for as long as it is open", state.asking.length === 1 && state.asking[0].id === cardD && state.following.length === 1 && state.everAsked.includes(cardA), { asking: state.asking, following: state.following.length });
  state.following[0].began -= 3 * 3_600_000;
  state.asking[0].at -= 3 * 3_600_000;
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  printed = "";
  town = start();
  await until(() => printed.includes("微信里发给"), 8000);
  const tasksThen = taken.length;
  got = await writes(`#${cardD} 2`);
  check("answered the moment the town is back, hours after it was asked, it is still an answer and not a task", answers.at(-1)?.id === cardD && taken.length === tasksThen && got.said.some((text) => text.includes(`问题 #${cardD}：选了「稳的」`)), { last: answers.at(-1), said: got.said, tasks: taken.length - tasksThen });
  await told("丁事要问我", "按你说的做了：稳的", 40_000);
  check("…and what it led to is still said", says().includes("「丁事要问我」✅ 做完了：按你说的做了：稳的"), says().slice(-3));
  await writes("新话题");
  got = await writes("#12 号问题修一下");
  check("words that only look like an answer, to a question never asked here, are a task like any other", taken.at(-1).detail.startsWith("#12 号问题修一下") && got.said[0].startsWith("已派给「甲」"), { said: got.said, last: taken.at(-1)?.detail });
  await told("#12 号问题修一下", "做完了");
  got = await writes("帮助");
  check("\"帮助\" explains what can be done here, without what only another chat can do", got.said[0].includes("直接发文字就是派活") && got.said[0].includes("回一个数字就是选那一项") && !got.said[0].includes("回复之前的某条任务消息"), got.said);

  // ---- what goes wrong on the way out must not stop the rest
  service.refuse = 1;
  got = await writes("新话题");
  await until(() => printed.includes("微信：回不了话"), 6000);
  got = await writes("清空附件");
  check("a thing the service won't take is noted and let go; the next is said as usual", printed.includes("微信：回不了话") && got.said[0] === "没有等着的附件。", { printed: printed.slice(-300), said: got.said });

  // ---- stopped and started again
  const slow = await writes("慢慢做一份报告");
  // The service hands an old message over again, last of all: the token to answer with must stay the newest one's.
  arrives({ message_id: first.id, context_token: first.context, item_list: words("帮我整理一下 README") });
  await wait(1500);
  const saidBefore = service.said.length;
  const takenBefore = taken.length;
  const answersBefore = answers.length;
  await stop(town);
  const syncFile = path.join(home, "town", "weixin-sync.json");
  const sync = JSON.parse(readFileSync(syncFile, "utf8"));
  check("how far the messages were read, and the token to answer with, are kept where only the owner reads", sync.cursor === `c${service.came.length}` && sync.context === slow.context && (statSync(syncFile).mode & 0o077) === 0, sync);
  // The service hands everything over again: as it may, when it isn't sure what was taken.
  writeFileSync(syncFile, JSON.stringify({ ...sync, cursor: "" }), { mode: 0o600 });
  printed = "";
  town = start();
  await told("慢慢做一份报告", "做完了", 30_000);
  const after = service.said.slice(saidBefore);
  check("a task being worked on over a restart is followed to its end, and answered with the token kept", after.map(textOf).includes("「慢慢做一份报告」✅ 做完了：改好了「慢慢做一份报告」") && after.every((message) => message.context_token === slow.context), after.map(textOf));
  check("messages dealt with before the restart are not dealt with again when they come again", taken.length === takenBefore && after.length === 1 && answers.length === answersBefore, { taken: taken.length, takenBefore, after: after.map(textOf) });

  // ---- a service that answers at once, and says it will wait longer than any clock allows
  const pollsAt = service.polls.length;
  service.instant = true;
  await wait(3000);
  service.instant = false;
  const spun = service.polls.length - pollsAt;
  got = await writes("清空附件");
  check("a service that answers at once with nothing is not asked again at once, and is still listened to afterwards", spun >= 1 && spun <= 5 && got.said[0] === "没有等着的附件。", { spun, said: got.said });

  // ---- a login gone stale
  const pollsBefore = service.polls.length;
  service.expired = true;
  await until(() => printed.includes("微信：登录过期了"), 8000);
  await wait(2500);
  check("a login the service no longer takes is said, with what to do, and not hammered at", printed.includes("微信：登录过期了") && printed.includes("--weixin-login") && service.polls.length - pollsBefore <= 2, { printed: printed.slice(-300), polls: service.polls.length - pollsBefore });
  check("every question to the service carried the login, and said what was asking", service.polls.every((each) => each.headers.authorization === `Bearer ${TOKEN}` && each.headers["ilink-app-id"] === "bot" && /^2\.4\.10\//.test(each.info?.channel_version ?? "")), service.polls.slice(0, 2));
  const pageNow = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-town-token": "none" } }).then((answer) => answer.status, () => "gone");
  check("the town itself is still up", pageNow === 403, pageNow);
} finally {
  town?.kill();
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
