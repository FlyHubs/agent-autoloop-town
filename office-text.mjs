// The words in a Word document, an Excel workbook or a PowerPoint deck, as plain text. These files are zip archives of
// XML, which an Agent that may only read files can't open: the town writes the text beside the original instead.
// Nothing here runs anything in a file; what comes in this way may come from anyone, so every size is capped, an
// archive that claims more than it may hold is not read, and the XML is gone through once from start to end: a pattern
// that looks ahead for an end that never comes, from every place it might start, takes hours over a few hundred bytes.
// What is set down is counted, and the reading stops once there is more than would be kept: a cell or a table row
// said again and again would otherwise make hundreds of megabytes out of a few hundred bytes. Even so, the server
// reads a file in a process of its own, with a memory limit of its own, and gives up on it in time (textApart).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const LIMITS = { entries: 5000, entry: 64 * 1024 * 1024, total: 200 * 1024 * 1024, text: 2 * 1024 * 1024 };

/** The files in a zip archive, by name, each read only when asked for. */
function archive(bytes) {
  // The directory of the archive is at its end, after a comment of at most 64 KB.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("不是 zip 格式");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count > LIMITS.entries) throw new Error("文件太多");
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("目录坏了");
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    entries.set(bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"), { method, packed, size, local });
    at += 46 + nameLength + extra + comment;
  }
  let given = 0;
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.size > LIMITS.entry || (given += entry.size) > LIMITS.total) throw new Error("解开太大");
      if (entry.local + 30 > bytes.length || bytes.readUInt32LE(entry.local) !== 0x04034b50) throw new Error("文件坏了");
      const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
      const data = bytes.subarray(start, start + entry.packed);
      if (entry.method === 0) return data.toString("utf8");
      if (entry.method !== 8) throw new Error("压缩方式不认识");
      // Held to what the archive says it holds: a file that says little and unpacks to much is turned away.
      return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) }).toString("utf8");
    },
  };
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
/** The text runs inside some XML, by the name of their tag, joined as they come. */
const runs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^<>]*)?>([^<]*)</${tag}>`, "g"))].map((match) => decode(match[1])).join("");

/**
 * Each <name …>…</name> or <name …/> in some XML, in order, each with what its tag says and what is inside: "" for one
 * that closes itself. One inside another of the same name is not looked for. Goes once from start to end, whatever the
 * XML: a tag that never closes, or an element that never ends, ends the looking.
 */
function* elements(xml, name) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  let gt = -1; // where the next ">" is, from the place looked at last: looked for again only once passed
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const after = xml[start + open.length];
    at = start + open.length;
    // <rows…> or <cx…> is another name.
    if (after !== ">" && after !== "/" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r") continue;
    if (gt < at) gt = xml.indexOf(">", at);
    if (gt < 0) return;
    const head = xml.slice(at, gt);
    // Another tag begins before this one ends: this one is broken, and the next is looked at.
    if (head.includes("<")) continue;
    if (head.endsWith("/")) {
      yield { head: head.slice(0, -1), inside: "" };
      at = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { head, inside: xml.slice(gt + 1, end) };
    at = end + close.length;
  }
}
/** What is between the first <tag> and the </tag> after it; "" where there is none. */
const firstIn = (xml, tag) => {
  const start = xml.indexOf(`<${tag}>`);
  const end = start < 0 ? -1 : xml.indexOf(`</${tag}>`, start);
  return end < 0 ? "" : xml.slice(start + tag.length + 2, end);
};
/** A line with the blanks at its end taken off, counted from the end: a pattern for it slows to a crawl over long runs. */
const trimBlanks = (line) => {
  let end = line.length;
  while (end && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
};
// The columns Excel has, A to XFD. A cell said to be further right than that is no cell of a real sheet.
const COLUMNS = 16_384;
/** Counts the letters set down; full once there are more than the text kept at the end may hold. */
const budget = () => {
  let left = LIMITS.text;
  return { take: (text) => ((left -= text.length + 1), text), full: () => left < 0 };
};

/** A Word document: each paragraph a line; a table's rows as lines, their cells split by tabs. */
function word(zip) {
  const body = zip.read("word/document.xml");
  if (body === null) throw new Error("不是 Word 文档");
  const lines = [];
  const room = budget();
  let line = ""; // the paragraph being read
  let depth = 0; // tables inside tables count too, but only the outermost one's rows and cells are kept apart
  let cells = [];
  let cell = [];
  const ended = () => (depth ? cell.push(line) : lines.push(room.take(line)), (line = ""));
  for (const [whole, tag, text] of body.matchAll(/<(\/?w:(?:tbl|tr|tc|p)|w:tab|w:br|w:cr)\b[^<>]*>|<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>/g)) {
    if (room.full() || line.length > LIMITS.text) break;
    if (text !== undefined) line += decode(text);
    else if (tag === "w:tab") line += depth ? " " : "\t";
    else if (tag === "w:br" || tag === "w:cr") line += "\n";
    else if (tag === "w:p") whole.endsWith("/>") && ended();
    else if (tag === "/w:p") ended();
    else if (tag === "w:tbl") depth++;
    else if (tag === "/w:tbl") depth = Math.max(0, depth - 1);
    else if (depth === 1 && tag === "w:tr") cells = [];
    // A row or a cell that has ended is set down once: one that ends again without having begun again is empty.
    else if (depth === 1 && tag === "/w:tr") (lines.push(room.take(cells.join("\t"))), (cells = []));
    else if (depth === 1 && tag === "w:tc") cell = [];
    else if (depth === 1 && tag === "/w:tc") (cells.push(cell.filter((each) => each.trim()).join(" ").replace(/[\t\n]+/g, " ")), (cell = []));
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** An Excel workbook: each sheet under its name, each row a line, its cells split by tabs. */
function excel(zip) {
  const book = zip.read("xl/workbook.xml");
  if (book === null) throw new Error("不是 Excel 表格");
  const links = zip.read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...links.matchAll(/<Relationship\b[^<>]*>/g)].map(([tag]) => [/\bId="([^"]+)"/.exec(tag)?.[1], /\bTarget="([^"]+)"/.exec(tag)?.[1]]));
  const shared = [...elements(zip.read("xl/sharedStrings.xml") ?? "", "si")].map(({ inside }) => runs(inside, "t"));
  const out = [];
  const room = budget();
  sheets: for (const [tag] of book.matchAll(/<sheet\b[^<>]*>/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(tag)?.[1] ?? "");
    const target = targets.get(/\br:id="([^"]+)"/.exec(tag)?.[1]);
    if (!target) continue;
    const xml = zip.read(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (xml === null) continue;
    out.push(`## ${name}`);
    for (const { inside: row } of elements(xml, "row")) {
      const cells = [];
      // One shared string may be named by every cell there is: what a row comes to is counted as it is made.
      let size = 0;
      // Whether anything is in it: looking through the row for that would go over all 16,384 columns of every row.
      let any = false;
      for (const { head: attributes, inside } of elements(row, "c")) {
        // Where the cell is says which column: the gaps left by empty cells are kept, so columns stay lined up.
        const letters = /\br="([A-Z]{1,3})\d+"/.exec(attributes)?.[1] ?? "";
        const column = [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        if (column >= COLUMNS || (!letters && /\br="[A-Z]{4,}/.test(attributes))) continue;
        const kind = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const value = decode(firstIn(inside, "v"));
        const text = kind === "s" ? (shared[Number(value)] ?? "") : kind === "inlineStr" ? runs(inside, "t") : kind === "b" ? (value === "1" ? "TRUE" : "FALSE") : value;
        if ((size += text.length + 1) > LIMITS.text) break;
        if (column >= 0) cells[column] = text.replace(/[\t\n]+/g, " ");
        else cells.push(text.replace(/[\t\n]+/g, " "));
        if (text) any = true;
      }
      if (any) out.push(room.take(Array.from(cells, (cell) => cell ?? "").join("\t")));
      if (room.full()) break sheets;
    }
    out.push("");
  }
  return out.join("\n");
}

/** A PowerPoint deck: each slide under its number, each paragraph a line. */
function slides(zip) {
  const pages = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  if (!pages.length) throw new Error("不是 PowerPoint 文件");
  const room = budget();
  const out = [];
  for (const [index, page] of pages.entries()) {
    if (room.full()) break;
    out.push(room.take([`## 第 ${index + 1} 页`, ...zip.read(page).split(/<\/a:p>/).map((paragraph) => runs(paragraph, "a:t")).filter((line) => line.trim())].join("\n")));
  }
  return out.join("\n\n");
}

const KINDS = { ".docx": word, ".xlsx": excel, ".xlsm": excel, ".pptx": slides };

/** Whether a file of this name is one whose words can be taken out here. */
export const readable = (name) => Object.hasOwn(KINDS, /\.[^.]+$/.exec(String(name).toLowerCase())?.[0] ?? "");

/** The words in the file, as text no longer than the limit; null when there are none to be had. */
export function textOf(bytes, name) {
  const read = KINDS[/\.[^.]+$/.exec(String(name).toLowerCase())?.[0] ?? ""];
  if (!read) return null;
  const text = read(archive(bytes)).split("\n").map(trimBlanks).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  if (Buffer.byteLength(text) <= LIMITS.text) return text;
  // Cut on a whole letter: a letter cut in two reads back as replacement marks at the end, taken off here.
  let cut = Buffer.from(text).subarray(0, LIMITS.text).toString("utf8");
  while (cut.endsWith("\ufffd")) cut = cut.slice(0, -1);
  return `${cut}\n……（太长，后面的没转）`;
}

/**
 * The same as textOf, read in a process of its own so the server goes on answering meanwhile, and so that a file which
 * would take more memory than it is given brings down only that process: V8 gives up on a whole process when its heap
 * is full, threads and all. A file that takes longer than `ms`, more memory than `memory` MB, or can't be read gives "":
 * what textOf would give where the words couldn't be had. Null for a file of no known kind.
 */
export function textApart(bytes, name, { ms = 10_000, memory = 256 } = {}) {
  if (!readable(name)) return Promise.resolve(null);
  // Two at a time: each may take its memory limit. The time allowed counts from when its turn comes.
  return readApart(bytes, name, ms, memory);
}
let running = 0;
const waiting = [];
// The readers running now: a town that stops takes them with it, rather than leave them reading on their own.
const live = new Set();
process.on("exit", () => live.forEach((child) => child.kill("SIGKILL")));

function readApart(bytes, name, ms, memory) {
  return new Promise((resolve) => {
    const go = () => {
      running++;
      run(bytes, name, ms, memory).then((text) => {
        running--;
        waiting.shift()?.();
        resolve(text);
      });
    };
    if (running < 2) go();
    else waiting.push(go);
  });
}

function run(bytes, name, ms, memory) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${memory}`, fileURLToPath(import.meta.url), "--text-of", String(name)], { stdio: ["pipe", "pipe", "ignore"] });
    live.add(child);
    const out = [];
    let size = 0;
    let done = false;
    const end = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      live.delete(child);
      resolve(text);
    };
    const timer = setTimeout(() => end(""), ms);
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      // What comes back is the text, said as JSON: never longer than the limit allows, unless something is wrong.
      if ((size += chunk.length) > 8 * LIMITS.text) end("");
    });
    child.on("error", () => end(""));
    child.on("close", (code) => {
      let text = "";
      try {
        text = code === 0 ? JSON.parse(Buffer.concat(out).toString("utf8")) : "";
      } catch {
        // Cut short: nothing to be had.
      }
      end(typeof text === "string" || text === null ? text : "");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

// Started by textApart: read the one file given on stdin, say what came of it as JSON on stdout, and be done.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--text-of") {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    let text = "";
    try {
      text = textOf(Buffer.concat(chunks), process.argv[3]);
    } catch {
      // Not to be read: the empty text says so.
    }
    process.stdout.write(JSON.stringify(text));
  });
}
