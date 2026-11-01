// 生成 PWA / Apple 图标：绿墨方块 + 白色田字格 + 格中「云」（与 public/favicon.svg 同一视觉，坐标基于 100×100）。
// 纯 Node 实现（无 rsvg / imagemagick / 浏览器），本地、Docker、CI 构建产出一致。
// 「云」的字形轮廓取自 Noto Serif SC Bold（SIL OFL 1.1），已拍平成多边形存在 yun-glyph.json。
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public');
const GLYPH = JSON.parse(readFileSync(join(HERE, 'yun-glyph.json'), 'utf8')).polys; // [[x,y]...][]

const INK = [0x14, 0x69, 0x3f]; // 绿墨 #14693f
const PAPER = [255, 255, 255];
const GUIDE = [0x9c, 0xc3, 0xab]; // 田字格虚线

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function png(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 非零环绕规则：对每条扫描线 y 求出字形各条边的交点（x 与方向），按 x 排序后缓存；
// 判断点 (x, y) 时累加其右侧交点的方向即可（字形由多条闭合轮廓组成，含内孔）。
const EDGES = GLYPH.flatMap((poly) => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]));
let rowY = NaN;
let rowHits = [];
function crossings(y) {
  if (y === rowY) return rowHits;
  const hits = [];
  for (const [[ax, ay], [bx, by]] of EDGES) {
    if ((ay <= y && by > y) || (by <= y && ay > y)) {
      hits.push([ax + ((y - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1]);
    }
  }
  hits.sort((p, q) => p[0] - q[0]);
  rowY = y;
  rowHits = hits;
  return hits;
}
function inGlyph(x, y) {
  let wind = 0;
  for (const [hx, dir] of crossings(y)) if (hx > x) wind += dir;
  return wind !== 0;
}

// 在 100×100 坐标里取一个点的颜色。iOS 自己会切圆角，PNG 铺满不留透明角。
function sample(x, y) {
  const inCell = x >= 13 && x <= 87 && y >= 13 && y <= 87;
  if (!inCell) return INK;
  if (inGlyph(x, y)) return INK;
  const onV = Math.abs(x - 50) <= 0.7 && y >= 15 && y <= 85 && (y - 15) % 5.8 < 3.2;
  const onH = Math.abs(y - 50) <= 0.7 && x >= 15 && x <= 85 && (x - 15) % 5.8 < 3.2;
  return onV || onH ? GUIDE : PAPER;
}

function render(size) {
  const SS = 4; // 4×4 超采样抗锯齿
  const rgb = Buffer.alloc(size * size * 3);
  const acc = new Float64Array(size * 3);
  for (let py = 0; py < size; py++) {
    acc.fill(0);
    // 先逐条子扫描线、再逐像素：同一 y 的交点只算一次
    for (let sy = 0; sy < SS; sy++) {
      const y = ((py + (sy + 0.5) / SS) / size) * 100;
      for (let px = 0; px < size; px++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((px + (sx + 0.5) / SS) / size) * 100, y);
          acc[px * 3] += c[0];
          acc[px * 3 + 1] += c[1];
          acc[px * 3 + 2] += c[2];
        }
      }
    }
    const n = SS * SS;
    for (let px = 0; px < size; px++) {
      const o = (py * size + px) * 3;
      rgb[o] = Math.round(acc[px * 3] / n);
      rgb[o + 1] = Math.round(acc[px * 3 + 1] / n);
      rgb[o + 2] = Math.round(acc[px * 3 + 2] / n);
    }
  }
  return png(size, rgb);
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), render(size));
  console.log(`icon-${size}.png`);
}
