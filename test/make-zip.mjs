// A zip archive made from names and contents, for tests: each entry deflated unless asked to be stored, and an entry may
// say it is a different size than it is, to make the kind of archive that claims less than it holds.
import { deflateRawSync } from "node:zlib";

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function makeZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const { name, content, store = false, saysSize } of entries) {
    const data = Buffer.from(content);
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(saysSize ?? data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(saysSize ?? data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const w = (body) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
/** A small Word document: a heading, a paragraph with a tab and entities, a 2×2 table, a closing line. */
export const sampleDocx = () =>
  makeZip([
    { name: "[Content_Types].xml", content: "<Types/>" },
    {
      name: "word/document.xml",
      content: w(
        `<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>满意度调查</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t xml:space="preserve">甲 &amp; 乙</w:t></w:r><w:r><w:tab/><w:t>&#x4E19;</w:t></w:r></w:p>` +
          `<w:tbl><w:tblPr/><w:tr><w:trPr/><w:tc><w:tcPr/><w:p><w:r><w:t>学校</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>得分</w:t></w:r></w:p></w:tc></w:tr>` +
          `<w:tr><w:tc><w:p><w:r><w:t>一中</w:t></w:r></w:p><w:p><w:r><w:t>（本部）</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>92</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
          `<w:p/><w:p><w:r><w:t>完</w:t></w:r></w:p>`,
      ),
    },
  ]);
/** A small Excel workbook: two sheets, shared and inline strings, a number, a formula's value, a yes/no, a gap. */
export const sampleXlsx = () =>
  makeZip([
    { name: "xl/workbook.xml", content: `<workbook><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/><sheet name="说明 &amp; 备注" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>` },
    { name: "xl/sharedStrings.xml", content: `<sst><si><t>姓名</t></si><si><r><t>分</t></r><r><t>数</t></r></si><si><t>张三</t></si></sst>` },
    { name: "xl/worksheets/sheet1.xml", content: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><f>SUM(1,2)</f><v>88.5</v></c></row><row r="3"/></sheetData></worksheet>` },
    { name: "xl/worksheets/sheet2.xml", content: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>只看第一列</t></is></c></row></sheetData></worksheet>`, store: true },
  ]);
/** A small PowerPoint deck whose slide files sort wrongly as text: slide 10 must come after slide 2. */
export const samplePptx = () =>
  makeZip([
    { name: "ppt/slides/slide10.xml", content: `<p:sld><a:p><a:r><a:t>最后一页</a:t></a:r></a:p></p:sld>` },
    { name: "ppt/slides/slide2.xml", content: `<p:sld><a:p><a:r><a:t>第二页</a:t></a:r><a:r><a:t>接着说</a:t></a:r></a:p><a:p><a:r><a:t>另起一段</a:t></a:r></a:p></p:sld>` },
    { name: "ppt/slides/slide1.xml", content: `<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>` },
  ]);
