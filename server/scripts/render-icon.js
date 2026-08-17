// Rasterizes the Pocket Agent mark to a square PNG (RGB, no alpha).
// Geometry mirrors the inline SVG favicon in server/public/index.html,
// in the same 64x64 coordinate space, minus the rounded corners.
const zlib = require("zlib");
const fs = require("fs");

const SIZE = Number(process.argv[2] || 180);
const OUT = process.argv[3];

const BG = [0x14, 0x17, 0x1c];
const ACCENT = [0x4f, 0x8c, 0xff];
const DOT = [0xe8, 0xea, 0xed];

const CHEVRON = [[18, 20], [32, 32], [18, 44]];
const STROKE_HALF = 7.5 / 2;
const DOT_C = [44, 44], DOT_R = 5.5;

// distance from point to a segment (round caps fall out of this for free)
function distSeg(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

const SS = 4; // 4x4 supersampling for anti-aliasing
const scale = 64 / SIZE;
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
let o = 0;

for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // PNG filter type: none
  for (let x = 0; x < SIZE; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const ux = (x + (sx + 0.5) / SS) * scale;
        const uy = (y + (sy + 0.5) / SS) * scale;
        let c = BG;
        const dChev = Math.min(
          distSeg(ux, uy, CHEVRON[0], CHEVRON[1]),
          distSeg(ux, uy, CHEVRON[1], CHEVRON[2])
        );
        if (dChev <= STROKE_HALF) c = ACCENT;
        if (Math.hypot(ux - DOT_C[0], uy - DOT_C[1]) <= DOT_R) c = DOT;
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
    }
    const n = SS * SS;
    raw[o++] = Math.round(acc[0] / n);
    raw[o++] = Math.round(acc[1] / n);
    raw[o++] = Math.round(acc[2] / n);
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour RGB (no alpha)

fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log("wrote", OUT, SIZE + "x" + SIZE, fs.statSync(OUT).size + " bytes");
