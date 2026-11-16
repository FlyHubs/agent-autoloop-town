// A QR code of a short text, made here: so that an address a phone has to scan (the WeChat login) is shown without
// handing it to anyone else's service, and without a dependency. Byte mode, error correction level L, versions 1 to 10,
// which hold up to 271 bytes; a login address is well under that. Longer text gets null, and is shown as text.

// For each version: error correction bytes to a block, and the data bytes in each block (ISO/IEC 18004, level L).
const BLOCKS = [null, [7, [19]], [10, [34]], [15, [55]], [20, [80]], [26, [108]], [18, [68, 68]], [20, [78, 78]], [24, [97, 97]], [30, [116, 116]], [18, [68, 68, 69, 69]]];
// Where the small squares that keep a big code straight are centred.
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// Arithmetic in the field the error correction is worked in: GF(256), x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let power = 0, value = 1; power < 255; power++) {
  EXP[power] = EXP[power + 255] = value;
  LOG[value] = power;
  value = value & 0x80 ? ((value << 1) ^ 0x11d) & 0xff : value << 1;
}
const times = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
/** The error correction bytes for one block of data. */
function correctionOf(data, count) {
  let generator = [1];
  for (let root = 0; root < count; root++) {
    const next = new Array(generator.length + 1).fill(0);
    generator.forEach((factor, at) => ((next[at] ^= factor), (next[at + 1] ^= times(factor, EXP[root]))));
    generator = next;
  }
  const rest = new Array(count).fill(0);
  for (const byte of data) {
    const lead = byte ^ rest.shift();
    rest.push(0);
    for (let at = 0; at < count; at++) rest[at] ^= times(generator[at + 1], lead);
  }
  return rest;
}

/** The pattern each of the eight masks lays over the data: true where a module is flipped. */
const MASKS = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/** How hard a finished code is to read, by the standard's four counts: the mask with the lowest is the one used. */
function penaltyOf(modules) {
  const size = modules.length;
  let penalty = 0;
  let dark = 0;
  const lines = [];
  for (let at = 0; at < size; at++) lines.push(modules[at], modules.map((row) => row[at]));
  for (const line of lines) {
    for (let from = 0; from < size; ) {
      let to = from;
      while (to < size && line[to] === line[from]) to++;
      if (to - from >= 5) penalty += 3 + (to - from - 5);
      from = to;
    }
    // What looks like the corner squares, where there is none.
    const text = line.map((module) => (module ? "1" : "0")).join("");
    for (const like of ["10111010000", "00001011101"]) for (let at = text.indexOf(like); at >= 0; at = text.indexOf(like, at + 1)) penalty += 40;
  }
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (modules[row][column]) dark++;
      if (row < size - 1 && column < size - 1 && modules[row][column] === modules[row][column + 1] && modules[row][column] === modules[row + 1][column] && modules[row][column] === modules[row + 1][column + 1]) penalty += 3;
    }
  }
  return penalty + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

/** The code as rows of modules, true where dark. Null when the text is too long for the versions made here. */
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const version = BLOCKS.findIndex((blocks, at) => at > 0 && bytes.length <= blocks[1].reduce((sum, each) => sum + each, 0) - (at < 10 ? 2 : 3));
  if (version < 1) return null;
  const [correction, shares] = BLOCKS[version];
  const room = shares.reduce((sum, each) => sum + each, 0);

  // The data: that it is bytes, how many, the bytes, an end mark, then filler up to what the version holds.
  const bits = [];
  const put = (value, length) => {
    for (let at = length - 1; at >= 0; at--) bits.push((value >> at) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, room * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let filler = 0xec; bits.length < room * 8; filler ^= 0xec ^ 0x11) put(filler, 8);
  const data = [];
  for (let at = 0; at < bits.length; at += 8) data.push(bits.slice(at, at + 8).reduce((value, bit) => (value << 1) | bit, 0));

  // Split into blocks, each with its own error correction, then dealt out a byte from each in turn.
  const blocks = [];
  for (let at = 0, from = 0; at < shares.length; from += shares[at++]) blocks.push(data.slice(from, from + shares[at]));
  const checks = blocks.map((block) => correctionOf(block, correction));
  const words = [];
  for (let at = 0; at < Math.max(...shares); at++) for (const block of blocks) if (at < block.length) words.push(block[at]);
  for (let at = 0; at < correction; at++) for (const check of checks) words.push(check[at]);

  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (column, row, dark) => {
    if (row < 0 || row >= size || column < 0 || column >= size) return;
    modules[row][column] = dark;
    fixed[row][column] = true;
  };
  // The three corner squares, each with a light band round it.
  for (const [cornerColumn, cornerRow] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cornerColumn + dx, cornerRow + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
  }
  // The small squares, except where a corner square already stands.
  const centres = ALIGN[version];
  for (const centreRow of centres) {
    for (const centreColumn of centres) {
      const first = centres[0];
      const last = centres.at(-1);
      if ((centreRow === first && centreColumn === first) || (centreRow === first && centreColumn === last) || (centreRow === last && centreColumn === first)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(centreColumn + dx, centreRow + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // The two dotted lines between the corner squares.
  for (let at = 8; at < size - 8; at++) (set(at, 6, at % 2 === 0), set(6, at, at % 2 === 0));

  /** Which mask and which error correction level, said twice beside the corner squares. */
  const drawFormat = (mask) => {
    const said = (0b01 << 3) | mask;
    let rest = said;
    for (let at = 0; at < 10; at++) rest = (rest << 1) ^ ((rest >> 9) * 0x537);
    const format = ((said << 10) | rest) ^ 0x5412;
    const bit = (at) => ((format >> at) & 1) === 1;
    for (let at = 0; at <= 5; at++) set(8, at, bit(at));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let at = 9; at < 15; at++) set(14 - at, 8, bit(at));
    for (let at = 0; at < 8; at++) set(size - 1 - at, 8, bit(at));
    for (let at = 8; at < 15; at++) set(8, size - 15 + at, bit(at));
    set(8, size - 8, true);
  };
  drawFormat(0);
  // From version 7 on, the version itself, said twice.
  if (version >= 7) {
    let rest = version;
    for (let at = 0; at < 12; at++) rest = (rest << 1) ^ ((rest >> 11) * 0x1f25);
    const said = (version << 12) | rest;
    for (let at = 0; at < 18; at++) {
      const dark = ((said >> at) & 1) === 1;
      const [a, b] = [size - 11 + (at % 3), Math.floor(at / 3)];
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // The words go in two columns at a time, from the bottom right, up and then down, round whatever is already there.
  let at = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (fixed[row][column]) continue;
        modules[row][column] = at < words.length * 8 && ((words[at >> 3] >> (7 - (at & 7))) & 1) === 1;
        at++;
      }
    }
    upward = !upward;
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const masked = modules.map((line, row) => line.map((dark, column) => (fixed[row][column] ? dark : dark !== MASKS[mask](row, column))));
    const penalty = penaltyOf(masked);
    if (!best || penalty < best.penalty) best = { penalty, modules: masked };
  }
  return best.modules;
}

/** The code for a terminal: two rows of modules to a line of text, dark on light whatever the terminal's own colours. */
export function qrText(modules, margin = 2) {
  const size = modules.length + margin * 2;
  const dark = (row, column) => modules[row - margin]?.[column - margin] === true;
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let column = 0; column < size; column++) line += dark(row, column) ? (dark(row + 1, column) ? "█" : "▀") : dark(row + 1, column) ? "▄" : " ";
    lines.push(`\u001b[30;47m${line}\u001b[0m`);
  }
  return lines.join("\n");
}

/** The code as a picture, with the light margin the standard asks for. */
export function qrSvg(modules, margin = 4) {
  const size = modules.length + margin * 2;
  let path = "";
  modules.forEach((line, row) => line.forEach((dark, column) => dark && (path += `M${column + margin} ${row + margin}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
