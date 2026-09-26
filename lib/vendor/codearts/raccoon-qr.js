const DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
const EC_BLOCKS_M = [
  void 0,
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }
];
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 256) !== 0) x ^= 285;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}
function polyMul(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i] ?? 0, b[j] ?? 0);
    }
  }
  return result;
}
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, GF_EXP[i] ?? 0]);
  }
  return poly;
}
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const buf = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i] ?? 0;
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j] ?? 0, coef);
    }
  }
  return buf.slice(data.length);
}
function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version++) {
    const capacityBits = (DATA_CODEWORDS[version] ?? 0) * 8;
    const overheadBits = 4 + (version <= 9 ? 8 : 16);
    if (overheadBits + byteLength * 8 <= capacityBits) return version;
  }
  return void 0;
}
function buildCodewords(bytes, version) {
  const blocks = EC_BLOCKS_M[version];
  if (blocks === void 0) throw new Error(`raccoon: \u4E0D\u652F\u6301\u7684\u4E8C\u7EF4\u7801\u7248\u672C ${version}`);
  const totalDataCodewords = DATA_CODEWORDS[version] ?? 0;
  const capacityBits = totalDataCodewords * 8;
  const bits = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push(value >> i & 1);
  };
  pushBits(4, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);
  const terminator = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const PAD_BYTES = [236, 17];
  for (let i = 0; bits.length < capacityBits; i++) {
    pushBits(PAD_BYTES[i % 2] ?? 0, 8);
  }
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = byte << 1 | (bits[i + j] ?? 0);
    dataCodewords.push(byte);
  }
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, dataPerBlock] of blocks.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + dataPerBlock);
      offset += dataPerBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
    }
  }
  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i] ?? 0);
    }
  }
  for (let i = 0; i < blocks.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i] ?? 0);
    }
  }
  return result;
}
function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}
function drawFinderPattern(modules, isFunction, size, x, y) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const dark = dist !== 2 && dist !== 4;
      modules[yy][xx] = dark;
      isFunction[yy][xx] = true;
    }
  }
}
function drawAlignmentPattern(modules, isFunction, x, y) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      modules[y + dy][x + dx] = dark;
      isFunction[y + dy][x + dx] = true;
    }
  }
}
function drawFunctionPatterns(modules, isFunction, size, version) {
  for (let i = 0; i < size; i++) {
    const dark = i % 2 === 0;
    modules[6][i] = dark;
    isFunction[6][i] = true;
    modules[i][6] = dark;
    isFunction[i][6] = true;
  }
  drawFinderPattern(modules, isFunction, size, 3, 3);
  drawFinderPattern(modules, isFunction, size, size - 4, 3);
  drawFinderPattern(modules, isFunction, size, 3, size - 4);
  const positions = alignmentPositions(version, size);
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const isCorner = i === 0 && j === 0 || i === 0 && j === n - 1 || i === n - 1 && j === 0;
      if (isCorner) continue;
      drawAlignmentPattern(modules, isFunction, positions[i] ?? 0, positions[j] ?? 0);
    }
  }
  drawFormatBits(modules, isFunction, size, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = rem << 1 ^ (rem >>> 11) * 7973;
    }
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const dark = (bits >> i & 1) === 1;
      const a = size - 11 + i % 3;
      const b = Math.floor(i / 3);
      modules[b][a] = dark;
      isFunction[b][a] = true;
      modules[a][b] = dark;
      isFunction[a][b] = true;
    }
  }
}
function drawFormatBits(modules, isFunction, size, mask) {
  const data = 0 << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = rem << 1 ^ (rem >>> 9) * 1335;
  }
  const bits = (data << 10 | rem) ^ 21522;
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  const bit = (i) => (bits >> i & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 7 + (i - 8), bit(i));
  set(8, size - 8, true);
}
function drawCodewords(modules, isFunction, size, codewords) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = (right + 1 & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] !== true && i < codewords.length * 8) {
          const byte = codewords[i >>> 3] ?? 0;
          modules[y][x] = (byte >> 7 - (i & 7) & 1) === 1;
          i++;
        }
      }
    }
  }
}
function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x] === true) continue;
      let invert;
      switch (mask) {
        case 0:
          invert = (x + y) % 2 === 0;
          break;
        case 1:
          invert = y % 2 === 0;
          break;
        case 2:
          invert = x % 3 === 0;
          break;
        case 3:
          invert = (x + y) % 3 === 0;
          break;
        case 4:
          invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
          break;
        case 5:
          invert = x * y % 2 + x * y % 3 === 0;
          break;
        case 6:
          invert = (x * y % 2 + x * y % 3) % 2 === 0;
          break;
        default:
          invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
          break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}
function computePenalty(modules, size) {
  const N1 = 3;
  const N2 = 3;
  const N3 = 40;
  const N4 = 10;
  let result = 0;
  for (let y = 0; y < size; y++) {
    const row = modules[y];
    result += penaltyForLine(row, size, N1, N3);
  }
  for (let x = 0; x < size; x++) {
    const col = [];
    for (let y = 0; y < size; y++) col.push(modules[y][x] === true);
    result += penaltyForLine(col, size, N1, N3);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += N2;
      }
    }
  }
  let dark = 0;
  for (const row of modules) {
    for (const cell of row) if (cell) dark++;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * N4;
  return result;
}
function penaltyForLine(line, size, N1, N3) {
  let result = 0;
  let runLength = 1;
  for (let i = 1; i < size; i++) {
    if (line[i] === line[i - 1]) {
      runLength++;
    } else {
      if (runLength >= 5) result += N1 + (runLength - 5);
      runLength = 1;
    }
  }
  if (runLength >= 5) result += N1 + (runLength - 5);
  const PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false];
  const PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i + 11 <= size; i++) {
    let matchA = true;
    let matchB = true;
    for (let j = 0; j < 11; j++) {
      if (line[i + j] !== PATTERN_A[j]) matchA = false;
      if (line[i + j] !== PATTERN_B[j]) matchB = false;
      if (!matchA && !matchB) break;
    }
    if (matchA) result += N3;
    if (matchB) result += N3;
  }
  return result;
}
function buildQrMatrix(text, options = {}) {
  const level = options.errorCorrection ?? "M";
  if (level !== "M") {
    throw new Error(`raccoon: \u4E8C\u7EF4\u7801\u76EE\u524D\u53EA\u652F\u6301\u7EA0\u9519\u7B49\u7EA7 M\uFF08\u6536\u5230 ${level}\uFF09`);
  }
  const forcedMask = options.mask;
  if (forcedMask !== void 0 && (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7)) {
    throw new Error(`raccoon: \u63A9\u7801\u5FC5\u987B\u662F 0..7 \u7684\u6574\u6570\uFF08\u6536\u5230 ${String(forcedMask)}\uFF09`);
  }
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  if (version === void 0) {
    throw new Error(
      `raccoon: \u4E8C\u7EF4\u7801\u5185\u5BB9\u8FC7\u957F\uFF08${bytes.length} \u5B57\u8282\uFF0C\u4E0A\u9650 213 \u5B57\u8282\uFF09\uFF0C\u8BF7\u7F29\u77ED\u5185\u5BB9`
    );
  }
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(modules, isFunction, size, version);
  drawCodewords(modules, isFunction, size, buildCodewords(bytes, version));
  let bestMask = 0;
  if (forcedMask !== void 0) {
    bestMask = forcedMask;
  } else {
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFunction, size, mask);
      drawFormatBits(modules, isFunction, size, mask);
      const penalty = computePenalty(modules, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      applyMask(modules, isFunction, size, mask);
    }
  }
  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(modules, isFunction, size, bestMask);
  return { size, modules };
}
function renderQrSvg(text, options = {}) {
  const px = options.size ?? 158;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? "#000000";
  const light = options.light ?? "#ffffff";
  const { size, modules } = buildQrMatrix(text);
  const dim = size + margin * 2;
  const segments = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]?.[x] === true) {
        segments.push(`M${x + margin},${y + margin}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${segments.join("")}" fill="${dark}"/></svg>`;
}
export {
  buildQrMatrix,
  renderQrSvg
};
