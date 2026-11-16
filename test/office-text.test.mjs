// Tests the reading of Word, Excel and PowerPoint files into plain text. It guards against: words lost, out of order, or
// run together (tables, sheets, slides 10 and up); escaped characters left escaped; and a file from anyone making the
// town hang, fill its memory, or crash: one that isn't a zip, one cut short, one that unpacks to far more than it says.
// Usage: node test/office-text.test.mjs
import { readable, textApart, textOf } from "../office-text.mjs";
import { makeZip, sampleDocx, samplePptx, sampleXlsx } from "./make-zip.mjs";

const results = [];
const check = (what, ok, saw) => results.push(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` → ${JSON.stringify(saw)?.slice(0, 400)}`}`);
const fails = (run) => {
  try {
    run();
    return "did not fail";
  } catch (error) {
    return error.message;
  }
};

let text = textOf(sampleDocx(), "报告.docx");
check("a Word document comes out a paragraph to a line, escaped characters as they are meant", text?.startsWith("满意度调查\n甲 & 乙\t丙\n"), text);
check("…its table a row to a line, cells split by tabs, a cell's paragraphs kept together", text?.includes("\n学校\t得分\n一中 （本部）\t92\n"), text);
check("…and what follows the table after it", text?.endsWith("\n完"), text);

text = textOf(sampleXlsx(), "成绩.XLSX");
check("an Excel workbook comes out sheet by sheet under each sheet's name", text?.startsWith("## 成绩\n") && text.includes("\n## 说明 & 备注\n只看第一列"), text);
check("…a row to a line, with an empty cell kept as a gap so columns line up", text?.includes("## 成绩\n姓名\t\t分数\n张三\tTRUE\t88.5"), text);

text = textOf(samplePptx(), "汇报.pptx");
check("a PowerPoint deck comes out slide by slide in their order, slide 10 after slide 2", text === "## 第 1 页\n封面\n\n## 第 2 页\n第二页接着说\n另起一段\n\n## 第 3 页\n最后一页", text);

check("only those kinds are read", readable("a.docx") && readable("B.XLSX") && readable("c.pptx") && !readable("d.doc") && !readable("e.pdf") && !readable("docx"), null);
check("a file of another kind gives nothing", textOf(Buffer.from("hello"), "a.txt") === null, null);

check("a file that isn't a zip is refused, not read", fails(() => textOf(Buffer.from("not a zip at all, just words".repeat(10)), "a.docx")) === "不是 zip 格式", null);
check("a zip that holds no document is said to be no document", fails(() => textOf(makeZip([{ name: "x.txt", content: "x" }]), "a.docx")) === "不是 Word 文档", null);
const cut = sampleDocx().subarray(0, 200);
check("a file cut short is refused", fails(() => textOf(cut, "a.docx")) !== "did not fail", fails(() => textOf(cut, "a.docx")));
const bomb = makeZip([{ name: "word/document.xml", content: `<w:p><w:r><w:t>${"x".repeat(5_000_000)}</w:t></w:r></w:p>`, saysSize: 100 }]);
check("a file that unpacks to far more than it says is stopped, not unpacked", bomb.length < 20_000 && fails(() => textOf(bomb, "a.docx")) !== "did not fail", { size: bomb.length });
const huge = makeZip([{ name: "word/document.xml", content: "x", saysSize: 100 * 1024 * 1024 }]);
check("a file that says it unpacks to more than is allowed is refused before anything is unpacked", fails(() => textOf(huge, "a.docx")) === "解开太大", fails(() => textOf(huge, "a.docx")));
const long = makeZip([{ name: "word/document.xml", content: Array.from({ length: 300_000 }, () => "<w:p><w:r><w:t>一二三四</w:t></w:r></w:p>").join("") }]);
text = textOf(long, "a.docx");
check("very long text is cut at the limit, on a whole letter, and says so", Buffer.byteLength(text) < 2.1 * 1024 * 1024 && text.endsWith("……（太长，后面的没转）") && !text.includes("�"), Buffer.byteLength(text ?? ""));

// A few hundred bytes from anyone must not keep the town busy: XML that never closes what it opens, long runs of
// blanks, a cell said to be millions of columns to the right. Each of these took seconds to hours before.
const book = (sheet, strings) =>
  makeZip([
    { name: "xl/workbook.xml", content: `<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
    ...(strings === undefined ? [] : [{ name: "xl/sharedStrings.xml", content: strings }]),
  ]);
const N = 80_000;
const slow = {
  "a Word tag that never closes": [makeZip([{ name: "word/document.xml", content: "<w:p".repeat(N) }]), "a.docx"],
  "a Word text tag that never closes": [makeZip([{ name: "word/document.xml", content: "<w:t ".repeat(N) }]), "a.docx"],
  "a long run of blanks with no line end after it": [makeZip([{ name: "word/document.xml", content: `<w:p><w:r><w:t>${" ".repeat(N)}x</w:t></w:r></w:p>` }]), "a.docx"],
  "rows that never close": [book("<row>".repeat(N)), "a.xlsx"],
  "cells that never close": [book(`<row>${"<c>".repeat(N)}</row>`), "a.xlsx"],
  "shared strings that never close": [book("", "<si>".repeat(N)), "a.xlsx"],
  "sheet tags that never close": [makeZip([{ name: "xl/workbook.xml", content: "<sheet".repeat(N) }]), "a.xlsx"],
  "a cell millions of columns to the right": [book(`<row r="1"><c r="AAAAA1" t="inlineStr"><is><t>x</t></is></c></row>`), "a.xlsx"],
  "a slide text tag that never closes": [makeZip([{ name: "ppt/slides/slide1.xml", content: "<a:t ".repeat(N) }]), "a.pptx"],
};
for (const [what, [file, name]] of Object.entries(slow)) {
  const began = performance.now();
  fails(() => textOf(file, name));
  const ms = Math.round(performance.now() - began);
  check(`${what} is read in well under a second (${file.length} bytes)`, ms < 1000, { ms });
}
text = textOf(book(`<row r="1"><c r="A1" t="inlineStr"><is><t>左</t></is></c><c r="XFD1" t="inlineStr"><is><t>最右</t></is></c><c r="XFE1" t="inlineStr"><is><t>表外</t></is></c></row>`), "a.xlsx");
check("a cell in the last column Excel has is kept; one past it is not", text?.startsWith("## a\n左\t") && text.endsWith("\t最右") && !text.includes("表外") && text.split("\t").length === 16384, text?.length);
text = textOf(makeZip([{ name: "word/document.xml", content: `<w:p><w:r><w:t>一 \t </w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p>` }]), "a.docx");
check("blanks at the end of a line are still taken off", text === "一\n二", text);

// A few hundred bytes that say the same thing again and again: a table whose rows end without beginning, a long shared
// string named by thousands of cells. They once made hundreds of megabytes of text, enough to bring a process down.
const rows = makeZip([{ name: "word/document.xml", content: `<w:tbl>${"<w:tc><w:p><w:r><w:t>格</w:t></w:r></w:p></w:tc>".repeat(20_000)}${"</w:tr>".repeat(20_000)}</w:tbl>` }]);
let began = performance.now();
text = textOf(rows, "a.docx");
check(`table rows that end again and again make no more text than is kept, and quickly (${rows.length} bytes)`, Buffer.byteLength(text ?? "") < 2.1 * 1024 * 1024 && performance.now() - began < 3000 && text.split("\n").filter((row) => row.includes("格")).length === 1, { bytes: Buffer.byteLength(text ?? ""), ms: performance.now() - began });
const named = book(`${'<row><c t="s"><v>0</v></c></row>'.repeat(4000)}`, `<sst><si><t>${"字".repeat(100_000)}</t></si></sst>`);
began = performance.now();
text = textOf(named, "a.xlsx");
check(`one long shared string named by every cell makes no more text than is kept, and quickly (${named.length} bytes)`, Buffer.byteLength(text ?? "") < 2.1 * 1024 * 1024 && text.endsWith("……（太长，后面的没转）") && performance.now() - began < 3000, { bytes: Buffer.byteLength(text ?? ""), ms: performance.now() - began });

// Away from the server's own process: whatever a file does, the town goes on answering, and gives up on it in time.
const apart = await textApart(sampleDocx(), "报告.docx");
check("read in a thread of its own, a document comes out the same", apart === textOf(sampleDocx(), "报告.docx"), apart);
check("…a file of no known kind gives nothing", (await textApart(Buffer.from("hello"), "a.txt")) === null, null);
check("…a file that can't be read gives the empty text", (await textApart(Buffer.from("not a zip"), "a.docx")) === "", null);
began = performance.now();
const late = await textApart(long, "a.docx", { ms: 1 });
check("…one that takes longer than allowed is given up on, as the empty text", late === "" && performance.now() - began < 2000, { late: late?.slice?.(0, 20), ms: performance.now() - began });
began = performance.now();
let ticks = 0;
const ticking = setInterval(() => ticks++, 10);
await textApart(long, "a.docx");
clearInterval(ticking);
check("…and while it reads, this thread is free", ticks >= Math.floor((performance.now() - began) / 10 / 3), { ticks, ms: performance.now() - began });
const starved = await textApart(long, "a.docx", { memory: 8 });
check("…one that needs more memory than its process is given brings down that process only, and gives the empty text", starved === "" && process.memoryUsage().rss > 0, starved?.slice?.(0, 20));

const failed = results.some((line) => line.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(failed ? "\nSOME FAILED" : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
