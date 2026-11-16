// WeChat, through Tencent's iLink bot interface (the one behind 微信 ClawBot): HTTPS and JSON, with messages fetched by
// long polling, so this machine needs no public address. A WeChat account is bound by scanning a code; what that account
// then writes to its ClawBot arrives here, and what is sent from here appears in that chat.
//
// Written against Tencent's own account of the protocol and their MIT-licensed client, openclaw-weixin 2.4.10
// (github.com/Tencent/openclaw-weixin, docs/protocol.md). Only what the town needs is here: binding, hearing, saying,
// and pictures and files both ways. It uses nothing but Node.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Where the service is, the version of Tencent's client whose protocol this speaks, and what this says it is. */
export const WEIXIN = { api: "https://ilinkai.weixin.qq.com", cdn: "https://novac2c.cdn.weixin.qq.com/c2c", speaks: "2.4.10", agent: "AutoloopTown/1.0" };
/** What the service answers when a login is no longer good. */
export const EXPIRED = -14;

const [major, minor, patch] = WEIXIN.speaks.split(".").map(Number);
const COMMON = { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String((major << 16) | (minor << 8) | patch) };
// A host other than Tencent's own says so after the protocol version, and names itself: that is how the service is told
// what is talking to it. Neither is a credential.
const INFO = { channel_version: `${WEIXIN.speaks}/town`, bot_agent: WEIXIN.agent };

/**
 * Only an address reached over HTTPS. This machine itself over plain HTTP is let through only while the service's
 * address has been set from outside: which is how a test stands in for the service, and nothing an answer can bring about.
 */
function safe(address) {
  const url = new URL(address);
  if (url.protocol === "https:" || (url.protocol === "http:" && process.env.TOWN_WEIXIN_API && ["127.0.0.1", "localhost"].includes(url.hostname))) return url;
  throw new Error("不是 HTTPS 地址");
}
const slashed = (base) => (String(base).endsWith("/") ? String(base) : `${base}/`);
/** Message ids are longer numbers than JavaScript keeps whole, so they are read as text. */
const parse = (raw) => JSON.parse(raw.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(\d+)/g, '"$1":"$2"'));
/** The code an answer failed with, or 0. Anything but nought counts, however it is written. */
function failed(answer) {
  for (const each of [answer?.ret, answer?.errcode]) {
    if (each === undefined || each === null || each === "" || each === 0) continue;
    const code = Number(each);
    if (code !== 0) return Number.isFinite(code) ? code : 1;
  }
  return 0;
}
const refusal = (what, answer) =>
  Object.assign(new Error(failed(answer) === EXPIRED ? "登录过期了，要重新扫码" : `${what}被拒了（${failed(answer)}${answer.errmsg ? ` ${String(answer.errmsg).slice(0, 80)}` : ""}）`), { code: failed(answer) });

async function ask(method, base, endpoint, { body, token, timeout = 15_000, signal } = {}) {
  const headers = { ...COMMON };
  if (method === "POST") Object.assign(headers, { "content-type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64") });
  if (token) headers.Authorization = `Bearer ${token}`;
  const limit = AbortSignal.timeout(Math.min(120_000, Math.max(1000, Number(timeout) || 15_000)));
  // Sent on nowhere else: what is asked here carries the login, and goes only to the address it was meant for.
  const response = await fetch(new URL(endpoint, slashed(safe(base).href)), { method, headers, body, redirect: "error", signal: signal ? AbortSignal.any([signal, limit]) : limit });
  const text = await response.text();
  if (!response.ok) throw new Error(`服务返回 ${response.status}`);
  return text;
}

/** The key a picture or file was sealed with: sixteen bytes, written either as they are or as thirty-two hex letters. */
function keyFrom(base64) {
  const decoded = Buffer.from(String(base64), "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new Error("解开它的钥匙样子不对");
}
/** What kind of picture some bytes are, as the ending of a file name; nothing when they are no picture known here. */
function endingOf(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return ".png";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  return "";
}

/**
 * The service, as a few things that can be asked of it. A `session` is what a binding gave: `{ token, baseUrl }`.
 * The two addresses can be set from outside so that a test can stand in for the service on this machine.
 */
export function weixin({ api = process.env.TOWN_WEIXIN_API || WEIXIN.api, cdn = process.env.TOWN_WEIXIN_CDN || WEIXIN.cdn } = {}) {
  const post = async (what, session, endpoint, body, options = {}) => {
    const answer = parse(await ask("POST", session.baseUrl, endpoint, { body: JSON.stringify({ ...body, base_info: INFO }), token: session.token, ...options }));
    if (failed(answer)) throw refusal(what, answer);
    return answer;
  };
  const message = (to, id, context, items) => ({ msg: { from_user_id: "", to_user_id: to, client_id: id, message_type: 2, message_state: 2, item_list: items, context_token: context || undefined } });

  return {
    api,
    /** A code to scan, to bind a WeChat account. `known` are the tokens this machine already holds, newest last. */
    async code(known = []) {
      const answer = JSON.parse(await ask("POST", api, "ilink/bot/get_bot_qrcode?bot_type=3", { body: JSON.stringify({ local_token_list: known.slice(-10) }) }));
      if (typeof answer.qrcode !== "string" || !answer.qrcode || typeof answer.qrcode_img_content !== "string" || !answer.qrcode_img_content) throw new Error("没拿到二维码");
      return { code: answer.qrcode, shown: answer.qrcode_img_content };
    },
    /** How the scanning stands. The service holds the question open; not hearing back in time is no news. */
    async scanned(base, code, pin = "") {
      try {
        return JSON.parse(await ask("GET", base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}${pin ? `&verify_code=${encodeURIComponent(pin)}` : ""}`, { timeout: 35_000 }));
      } catch {
        return { status: "wait" };
      }
    },
    /** What has come since `cursor`. The service holds the question open until something comes or its time is up. */
    async updates(session, cursor, timeout = 40_000, signal) {
      let raw;
      try {
        raw = await ask("POST", session.baseUrl, "ilink/bot/getupdates", { body: JSON.stringify({ get_updates_buf: cursor ?? "", base_info: INFO }), token: session.token, timeout, signal });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") return { messages: [], cursor: "", wait: 0 };
        throw error;
      }
      const answer = parse(raw);
      if (failed(answer)) throw refusal("收消息", answer);
      return { messages: Array.isArray(answer.msgs) ? answer.msgs : [], cursor: typeof answer.get_updates_buf === "string" ? answer.get_updates_buf : "", wait: Number(answer.longpolling_timeout_ms) > 0 ? Number(answer.longpolling_timeout_ms) : 0 };
    },
    /** Says words to someone. `context` is the token that came with what they last wrote; `id` names this message. */
    async say(session, to, words, context, id) {
      await post("发消息", session, "ilink/bot/sendmessage", message(to, id, context, [{ type: 1, text_item: { text: words } }]));
    },
    /** Sends a picture or a file: sealed, put on the service's storage, then pointed to by a message. */
    async send(session, to, bytes, name, picture, context, id) {
      const key = randomBytes(16);
      const filekey = randomBytes(16).toString("hex");
      const cipher = createCipheriv("aes-128-ecb", key, null);
      const sealed = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const place = await post("传文件", session, "ilink/bot/getuploadurl", {
        filekey, media_type: picture ? 1 : 3, to_user_id: to, rawsize: bytes.length, rawfilemd5: createHash("md5").update(bytes).digest("hex"), filesize: sealed.length, no_need_thumb: true, aeskey: key.toString("hex"),
      });
      const whole = typeof place.upload_full_url === "string" ? place.upload_full_url.trim() : "";
      if (!whole && (typeof place.upload_param !== "string" || !place.upload_param)) throw new Error("没拿到上传的地址");
      const target = safe(whole || `${cdn}/upload?encrypted_query_param=${encodeURIComponent(place.upload_param)}&filekey=${encodeURIComponent(filekey)}`);
      let found = "";
      let last = null;
      for (let attempt = 0; attempt < 3 && !found; attempt++) {
        try {
          const response = await fetch(target, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sealed, redirect: "error", signal: AbortSignal.timeout(120_000) });
          await response.arrayBuffer().catch(() => {});
          // Turned away for what was sent: sending the same again won't help.
          if (response.status >= 400 && response.status < 500) throw Object.assign(new Error(`上传被拒了（${response.status}）`), { final: true });
          if (response.status !== 200) throw new Error(`上传没成（${response.status}）`);
          found = response.headers.get("x-encrypted-param") ?? "";
          if (!found) throw new Error("传上去了，但没拿到取回它的凭据");
        } catch (error) {
          last = error;
          if (error.final) break;
        }
      }
      if (!found) throw last ?? new Error("上传没成");
      // The key goes in the message as its hex letters, base64'd: that is how Tencent's own client writes it.
      const media = { encrypt_query_param: found, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 };
      const item = picture ? { type: 2, image_item: { media, mid_size: sealed.length } } : { type: 4, file_item: { media, file_name: name, len: String(bytes.length) } };
      await post("发文件", session, "ilink/bot/sendmessage", message(to, id, context, [item]));
    },
    /** Brings in the picture, file or video one item of a message points to, no bigger than `most`, and unseals it. */
    async fetch(item, most) {
      const part = item?.type === 2 ? item.image_item : item?.type === 4 ? item.file_item : item?.type === 5 ? item.video_item : null;
      const media = part?.media;
      if (!media || (!media.encrypt_query_param && !media.full_url)) throw new Error("消息里没有可取的内容");
      // A picture may carry its key in hex beside the media, and may have none at all; a file or a video always has one.
      const key = item.type === 2 && /^[0-9a-f]{32}$/i.test(String(part.aeskey ?? "")) ? Buffer.from(part.aeskey, "hex") : media.aes_key ? keyFrom(media.aes_key) : null;
      if (!key && item.type !== 2) throw new Error("没给解开它的钥匙");
      const from = safe(typeof media.full_url === "string" && media.full_url ? media.full_url : `${cdn}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`);
      const response = await fetch(from, { redirect: "error", signal: AbortSignal.timeout(120_000) }).catch(() => {
        throw new Error("取不下来（连不上，或者被转到了别处）");
      });
      if (!response.ok || !response.body) throw new Error(`取不下来（${response.status}）`);
      // Sealed, a thing is at most one block longer than what it holds.
      const room = most + 16;
      const tooBig = () => new Error(`超过 ${most / 1048576} MB`);
      if (Number(response.headers.get("content-length") ?? 0) > room) {
        await response.body.cancel().catch(() => {});
        throw tooBig();
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > room) throw tooBig();
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      if (key) {
        try {
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
        } catch {
          throw new Error("取下来了，但解不开");
        }
      }
      return { bytes, ending: endingOf(bytes) };
    },
  };
}

/**
 * Binds a WeChat account: shows a code, waits for it to be scanned and confirmed on the phone, and gives back what the
 * service then hands over. `show` is given what the code must say; `pin` is asked for the digits the phone shows, when
 * the service wants them; `say` is told how things stand.
 */
export async function bind(client, { show, pin, say, known = [], patience = 480_000 }) {
  let { code, shown } = await client.code(known);
  await show(shown);
  let base = client.api;
  let typed = "";
  let told = false;
  let codes = 1;
  for (const until = Date.now() + patience; Date.now() < until; ) {
    const now = await client.scanned(base, code, typed);
    const status = String(now?.status ?? "wait");
    if (status === "confirmed") {
      if (![now.bot_token, now.ilink_bot_id, now.ilink_user_id].every((each) => typeof each === "string" && each)) throw new Error("手机上确认了，但没拿到凭据");
      return { token: now.bot_token, botId: now.ilink_bot_id, userId: now.ilink_user_id, baseUrl: safe(typeof now.baseurl === "string" && now.baseurl ? now.baseurl : client.api).href };
    }
    if (status.includes("need_verifycode")) {
      // Asked for again, the digits given last time were wrong.
      typed = await pin(typed !== "");
    } else if (status === "scaned") {
      typed = "";
      if (!told) say("扫到了，在手机上点确认。");
      told = true;
    } else if (status === "scaned_but_redirect") {
      if (typeof now.redirect_host === "string" && /^[\w.-]+(:\d+)?$/.test(now.redirect_host)) base = `https://${now.redirect_host}`;
    } else if (status === "binded_redirect") {
      throw new Error("这个微信已经连着这台电脑了，没有签发新的凭据：原来的登录接着用。");
    } else if (status === "expired" || status === "verify_code_blocked") {
      if (++codes > 4) throw new Error("二维码换了几次都没扫成，过一会儿再试。");
      typed = "";
      told = false;
      ({ code, shown } = await client.code(known));
      say(status === "expired" ? "二维码过期了，换了一张：" : "数字输错的次数太多，换了一张二维码：");
      await show(shown);
    }
    // The service holds each question open while there is nothing to say. Should it answer at once instead, this is
    // what keeps the asking from turning into a spin: whatever it said, a rest before it is asked again.
    if (!status.includes("need_verifycode")) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("等了很久没有扫码，停了。要连的话重新运行一次。");
}
