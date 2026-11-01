// 生成 PWA / Apple 图标：绿底 macOS 终端风格（白色 `>_` 提示符 + 左上小圆点）。
// 纯 Node 实现，无需外部工具（rsvg/imagemagick），保证本地 / Docker / CI 构建都产出一致图标。
// 与 public/favicon.svg 同一视觉；改图标时两边一起改（坐标基于 100×100 视图）。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOP = [0x13, 0xd8, 0x73]; // 顶部亮绿 #13D873
const BOT = [0x05, 0xa8, 0x52]; // 底部深绿 #05A852
const WHITE = [255, 255, 255];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

// 点到线段距离（用于画带圆角端点的笔画）
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function makePng(size) {
  const s = size / 100; // 视图 100 → 像素
  const radius = 23 * s; // 圆角，与 favicon 一致
  const stroke = (7.5 / 2) * s; // 笔画半宽
  // 提示符坐标（基于 100 视图）
  const chevron = [
    [28, 24],
    [42, 38],
    [28, 52],
  ].map(([x, y]) => [x * s, y * s]);
  const underline = [
    [50, 54],
    [66, 54],
  ].map(([x, y]) => [x * s, y * s]);

  const inRounded = (x, y) => {
    const r = radius;
    const cx = x < r ? r : x > size - r ? size - r : x;
    const cy = y < r ? r : y > size - r ? size - r : y;
    if (cx === x && cy === y) return 1;
    const d = Math.hypot(x - cx, y - cy);
    return clamp01(r - d + 0.5); // 边缘 1px 抗锯齿
  };

  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter type 0
    const gy = y + 0.5;
    const mix = gy / size; // 竖直渐变系数
    const bg = [
      Math.round(TOP[0] + (BOT[0] - TOP[0]) * mix),
      Math.round(TOP[1] + (BOT[1] - TOP[1]) * mix),
      Math.round(TOP[2] + (BOT[2] - TOP[2]) * mix),
    ];
    for (let x = 0; x < size; x++) {
      const gx = x + 0.5;
      // 白色提示符覆盖度（取各形状最大值）
      let cov = 0;
      cov = Math.max(cov, clamp01(stroke - distToSeg(gx, gy, chevron[0][0], chevron[0][1], chevron[1][0], chevron[1][1]) + 0.5));
      cov = Math.max(cov, clamp01(stroke - distToSeg(gx, gy, chevron[1][0], chevron[1][1], chevron[2][0], chevron[2][1]) + 0.5));
      cov = Math.max(cov, clamp01(stroke - distToSeg(gx, gy, underline[0][0], underline[0][1], underline[1][0], underline[1][1]) + 0.5));

      const o = y * rowLen + 1 + x * 4;
      raw[o] = Math.round(bg[0] + (WHITE[0] - bg[0]) * cov);
      raw[o + 1] = Math.round(bg[1] + (WHITE[1] - bg[1]) * cov);
      raw[o + 2] = Math.round(bg[2] + (WHITE[2] - bg[2]) * cov);
      raw[o + 3] = Math.round(255 * inRounded(gx, gy));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-180.png', 180],
]) {
  writeFileSync(join(OUT, name), makePng(size));
  console.log('generated', name);
}
