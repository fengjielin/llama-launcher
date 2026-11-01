#!/usr/bin/env node
// 应用图标生成器（零第三方依赖）
//
// 产物：build/icon.png（512×512）+ build/icon.ico（16/24/32/48/64/128/256 七帧）
//
// 为什么自己光栅化，而不是用现成 SVG 转码：
//   · 本机没有 ImageMagick / cairosvg；
//   · electron-builder 的 PNG→ICO 转换要调 app-builder 的二进制，本机报错
//     （见 electron-builder.yml 的 win.icon 注释）。
// 做法：用有向距离场（SDF）拼几何体，逐像素解析抗锯齿，并且**每个尺寸单独渲染**。
// 小尺寸不是把 512 缩下来，而是按该尺寸重新光栅化，所以 16×16 依旧干净。
//
// 用法：
//   node scripts/make-icon.mjs                    # 输出到 build/（默认方案 prompt）
//   node scripts/make-icon.mjs --variant=face     # 换方案
//   node scripts/make-icon.mjs --out=../tmp       # 换输出目录
//   node scripts/make-icon.mjs --list             # 列出所有方案
//
// 配色取自界面主题（src/renderer/src/styles.css）：--accent 是 #2dd4bf。
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 设计参数
// ---------------------------------------------------------------------------

const TILE_MARGIN = 0.03; // 画布四周留白（相对边长）
const TILE_N = 4.2; // 超椭圆指数，4~5 接近 Windows 11 的圆角方块

const COLOR_TOP = [94, 234, 212]; // #5eead4
const COLOR_MID = [45, 212, 191]; // #2dd4bf（界面强调色）
const COLOR_BOTTOM = [9, 74, 68]; // #094a44
const COLOR_GLYPH = [247, 255, 253];

// ---------------------------------------------------------------------------
// 图形方案（单位坐标 0..100；cone = 两端半径不同的圆头圆柱体）
// ---------------------------------------------------------------------------

const VARIANTS = {
  // 终端提示符 ">_"：启动器跑进程、出日志，语义最贴，且任何尺寸都锐利。
  prompt: {
    fill: 0.66,
    smooth: 0.01,
    parts: [
      { s: { kind: 'cone', a: [25, 27], b: [50, 50], r1: 6.5, r2: 6.5 } },
      { s: { kind: 'cone', a: [50, 50], b: [25, 73], r1: 6.5, r2: 6.5 } },
      { s: { kind: 'cone', a: [57, 73], b: [79, 73], r1: 6.5, r2: 6.5 } },
    ],
  },
  // 正面羊驼脸：吉祥物路线，大尺寸好看，32×32 以下会糊成一团白。
  face: {
    fill: 0.60,
    smooth: 7,
    parts: [
      { s: { kind: 'ellipse', c: [50, 56], rx: 30, ry: 29 } },
      { s: { kind: 'ellipse', c: [50, 78], rx: 20, ry: 15 } },
      { s: { kind: 'cone', a: [36, 46], b: [26, 8], r1: 12, r2: 7 } },
      { s: { kind: 'cone', a: [64, 46], b: [74, 8], r1: 12, r2: 7 } },
      { s: { kind: 'circle', c: [38, 54], r: 5 }, cut: true },
      { s: { kind: 'circle', c: [62, 54], r: 5 }, cut: true },
    ],
  },
  // 站姿全身羊驼：构图饱满，但 16×16 只剩一个白块。
  body: {
    fill: 0.66,
    smooth: 4,
    parts: [
      { s: { kind: 'ellipse', c: [52, 50], rx: 19, ry: 12 } },
      { s: { kind: 'cone', a: [37, 54], b: [32, 25], r1: 10, r2: 7 } },
      { s: { kind: 'ellipse', c: [29, 22], rx: 10, ry: 8 } },
      { s: { kind: 'cone', a: [24, 24], b: [9, 26], r1: 6, r2: 3.8 } },
      { s: { kind: 'cone', a: [25, 17], b: [23, 3], r1: 3.4, r2: 1.2 } },
      { s: { kind: 'cone', a: [32, 16], b: [33, 2], r1: 3.4, r2: 1.2 } },
      { s: { kind: 'cone', a: [70, 43], b: [77, 36], r1: 3.6, r2: 1.6 } },
      { s: { kind: 'cone', a: [40, 56], b: [39, 90], r1: 3.8, r2: 2.6 } },
      { s: { kind: 'cone', a: [47, 58], b: [47, 90], r1: 3.8, r2: 2.6 } },
      { s: { kind: 'cone', a: [59, 58], b: [60, 90], r1: 3.8, r2: 2.6 } },
      { s: { kind: 'cone', a: [66, 56], b: [68, 90], r1: 3.8, r2: 2.6 } },
      { s: { kind: 'circle', c: [21, 22], r: 2.2 }, cut: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// SDF 基本体（负值在形体内）
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function sdEllipse(px, py, cx, cy, rx, ry, rotDeg = 0) {
  const a = (rotDeg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const x = (dx * Math.cos(a) + dy * Math.sin(a)) / rx;
  const y = (-dx * Math.sin(a) + dy * Math.cos(a)) / ry;
  return (Math.hypot(x, y) - 1) * Math.min(rx, ry);
}

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

function sdRoundCone(px, py, ax, ay, bx, by, r1, r2) {
  const bax = bx - ax;
  const bay = by - ay;
  const l2 = bax * bax + bay * bay;
  if (l2 === 0) return Math.hypot(px - ax, py - ay) - Math.max(r1, r2);
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax;
  const pay = py - ay;
  const y = pax * bax + pay * bay;
  const z = y - l2;
  const xvx = pax * l2 - bax * y;
  const xvy = pay * l2 - bay * y;
  const x2 = xvx * xvx + xvy * xvy;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function shapeSdf(shape, px, py) {
  switch (shape.kind) {
    case 'cone':
      return sdRoundCone(px, py, shape.a[0], shape.a[1], shape.b[0], shape.b[1], shape.r1, shape.r2);
    case 'ellipse':
      return sdEllipse(px, py, shape.c[0], shape.c[1], shape.rx, shape.ry, shape.rot);
    case 'circle':
      return Math.hypot(px - shape.c[0], py - shape.c[1]) - shape.r;
    default:
      throw new Error(`未知形状: ${shape.kind}`);
  }
}

/** 并集（smooth <= 0 时取硬并集）+ 挖空 */
function makeSdf(variant) {
  const { parts, smooth } = variant;
  return (x, y) => {
    let d = Infinity;
    for (const part of parts) {
      if (part.cut) continue;
      d = d === Infinity ? shapeSdf(part.s, x, y) : smin(d, shapeSdf(part.s, x, y), smooth);
    }
    for (const part of parts) {
      if (!part.cut) continue;
      d = Math.max(d, -shapeSdf(part.s, x, y));
    }
    return d;
  };
}

/** 先测图形外接框，再等比缩放到方块里并居中（避免手工摆位） */
function measureGlyph(sdf, fillRatio) {
  const R = 700;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < R; i++) {
    const y = -25 + (150 * i) / R;
    for (let j = 0; j < R; j++) {
      const x = -25 + (150 * j) / R;
      if (sdf(x, y) < 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { w, h, maxSide: Math.max(w, h), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, fillRatio };
}

// ---------------------------------------------------------------------------
// 光栅化
// ---------------------------------------------------------------------------

function superellipseCoverage(size, inset, n, SS) {
  const R = size * SS;
  const accum = new Float32Array(size * size);
  const half = size / 2;
  const a = half - inset * size;
  for (let y = 0; y < R; y++) {
    const py = (y + 0.5) / SS;
    const row = ((y / SS) | 0) * size;
    for (let x = 0; x < R; x++) {
      const px = (x + 0.5) / SS;
      const dx = Math.abs(px - half) / a;
      const dy = Math.abs(py - half) / a;
      if (dx ** n + dy ** n <= 1) accum[row + ((x / SS) | 0)] += 1;
    }
  }
  const norm = 1 / (SS * SS);
  for (let k = 0; k < accum.length; k++) accum[k] *= norm;
  return accum;
}

function glyphCoverage(size, SS, metric, sdf) {
  const R = size * SS;
  const accum = new Float32Array(size * size);
  const s = (metric.fillRatio * size) / metric.maxSide; // 像素 / 图形单位
  for (let y = 0; y < R; y++) {
    const py = (y + 0.5) / SS;
    const row = ((y / SS) | 0) * size;
    const gy = metric.cy + (py - size / 2) / s;
    for (let x = 0; x < R; x++) {
      const px = (x + 0.5) / SS;
      const gx = metric.cx + (px - size / 2) / s;
      const cov = clamp01(0.5 - sdf(gx, gy) * s);
      if (cov > 0) accum[row + ((x / SS) | 0)] += cov;
    }
  }
  const norm = 1 / (SS * SS);
  for (let k = 0; k < accum.length; k++) accum[k] *= norm;
  return accum;
}

function gradient(t) {
  const k = clamp01(t);
  if (k < 0.52) {
    const u = k / 0.52;
    return [lerp(COLOR_TOP[0], COLOR_MID[0], u), lerp(COLOR_TOP[1], COLOR_MID[1], u), lerp(COLOR_TOP[2], COLOR_MID[2], u)];
  }
  const u = (k - 0.52) / 0.48;
  return [
    lerp(COLOR_MID[0], COLOR_BOTTOM[0], u),
    lerp(COLOR_MID[1], COLOR_BOTTOM[1], u),
    lerp(COLOR_MID[2], COLOR_BOTTOM[2], u),
  ];
}

function render(size, sdf, metric) {
  // 小尺寸给更多子采样，避免 1px 宽的笔画被采没
  const SS = size <= 32 ? 10 : size <= 64 ? 6 : 4;
  const tile = superellipseCoverage(size, TILE_MARGIN, TILE_N, SS);
  const glyphMask = glyphCoverage(size, SS, metric, sdf);

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const ta = tile[idx];
      const g = clamp01(((x / size) * 0.34 + (y / size) * 0.66 - 0.06) / 0.92);
      const [cr, cg, cb] = gradient(g);
      // 左上柔光，避免方块过于平
      const dx = (x / size - 0.22) / 0.72;
      const dy = (y / size - 0.16) / 0.72;
      const lift = Math.max(0, 1 - Math.hypot(dx, dy)) ** 2 * 0.12;
      const r0 = cr + (255 - cr) * lift;
      const g0 = cg + (255 - cg) * lift;
      const b0 = cb + (255 - cb) * lift;

      const ga = glyphMask[idx] * ta;
      const o = idx * 4;
      out[o] = Math.round(lerp(r0, COLOR_GLYPH[0], ga));
      out[o + 1] = Math.round(lerp(g0, COLOR_GLYPH[1], ga));
      out[o + 2] = Math.round(lerp(b0, COLOR_GLYPH[2], ga));
      out[o + 3] = Math.round(ta * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG / ICO 编码
// ---------------------------------------------------------------------------

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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h = w) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 帧：统一用 32bpp BMP。
 *  256 帧也可以用内嵌 PNG（Windows Vista+ 支持、体积更小），但实测 .NET 的
 *  System.Drawing.Icon 只按 BMP 帧取图，遇到 PNG 帧会退到更小的尺寸，
 *  为了兼容性这里全部用 BMP（整份 ICO 约 360 KB，对桌面应用无所谓）。 */
function bmpFrame(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4; // BMP 自下而上
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const and = Buffer.alloc(maskRow * size, 0); // 全 0：交给 alpha 通道
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([header, xor, and]);
}

function encodeIco(frames) {
  const dir = Buffer.alloc(6 + frames.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(frames.length, 4);
  let off = dir.length;
  const blobs = [];
  frames.forEach((f, i) => {
    const p = 6 + i * 16;
    dir[p] = f.size >= 256 ? 0 : f.size; // 0 表示 256
    dir[p + 1] = f.size >= 256 ? 0 : f.size;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(f.data.length, p + 8);
    dir.writeUInt32LE(off, p + 12);
    off += f.data.length;
    blobs.push(f.data);
  });
  return Buffer.concat([dir, ...blobs]);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildVariant(name, outDir) {
  const variant = VARIANTS[name];
  if (!variant) throw new Error(`未知方案: ${name}（可用：${Object.keys(VARIANTS).join(', ')}）`);
  const sdf = makeSdf(variant);
  const metric = measureGlyph(sdf, variant.fill);

  mkdirSync(outDir, { recursive: true });
  const rendered = new Map();
  for (const size of [...SIZES, 512]) rendered.set(size, render(size, sdf, metric));
  for (const size of [...SIZES, 512]) {
    writeFileSync(`${outDir}/icon-${size}.png`, encodePng(rendered.get(size), size));
  }
  writeFileSync(`${outDir}/icon.png`, encodePng(rendered.get(512), 512));

  const frames = SIZES.map((size) => ({ size, data: bmpFrame(rendered.get(size), size) }));
  writeFileSync(`${outDir}/icon.ico`, encodeIco(frames));
  console.log(`icon(${name}) -> ${outDir}  [${SIZES.join('/')} + 512]`);
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(Object.keys(VARIANTS).join('\n'));
  process.exit(0);
}
const variant = args.find((a) => a.startsWith('--variant='))?.slice(10) ?? 'prompt';
const outDir = resolve(HERE, args.find((a) => a.startsWith('--out='))?.slice(6) ?? '../build');
buildVariant(variant, outDir);
