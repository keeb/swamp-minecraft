/**
 * Tests for the dependency-free PNG decoder. A small reference encoder below
 * builds PNGs for every colour type, bit depth, filter and interlace mode so
 * the decoder is checked against known pixels.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { decodePng } from "./png.ts";

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

interface EncodeOpts {
  width: number;
  height: number;
  colorType: number;
  depth: number;
  /** samples[y][x] = channel values in the PNG's own sample space */
  samples: number[][][];
  filter?: number;
  interlace?: boolean;
  palette?: number[][];
  trns?: Uint8Array;
}

async function encodePng(o: EncodeOpts): Promise<Uint8Array> {
  const ch = CHANNELS[o.colorType];
  const bits = ch * o.depth;
  const bpp = Math.max(1, bits >> 3);
  const passes = o.interlace ? ADAM7 : [[0, 0, 1, 1]];
  const rows: Uint8Array[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((o.width - x0) / dx);
    const ph = Math.ceil((o.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil(pw * bits / 8);
    let prev = new Uint8Array(stride);
    for (let r = 0; r < ph; r++) {
      const line = new Uint8Array(stride);
      for (let c = 0; c < pw; c++) {
        const px = o.samples[y0 + r * dy][x0 + c * dx];
        for (let k = 0; k < ch; k++) {
          const v = px[k];
          if (o.depth === 16) {
            line[(c * ch + k) * 2] = v >> 8;
            line[(c * ch + k) * 2 + 1] = v & 0xff;
          } else if (o.depth === 8) {
            line[c * ch + k] = v;
          } else {
            const bit = (c * ch + k) * o.depth;
            line[bit >> 3] |= v << (8 - o.depth - (bit & 7));
          }
        }
      }
      const f = o.filter ?? 0;
      const out = new Uint8Array(stride + 1);
      out[0] = f;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const cc = i >= bpp ? prev[i - bpp] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, cc)][f];
        out[i + 1] = (line[i] - pred) & 0xff;
      }
      rows.push(out);
      prev = line;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, o.width);
  dv.setUint32(4, o.height);
  ihdr[8] = o.depth;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ? 1 : 0;
  const extra: Uint8Array[] = [];
  if (o.palette) extra.push(chunk("PLTE", new Uint8Array(o.palette.flat())));
  if (o.trns) extra.push(chunk("tRNS", o.trns));
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", await deflate(concat(rows))),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Deterministic RGBA test image. */
function rgbaImage(w: number, h: number): number[][][] {
  return Array.from(
    { length: h },
    (_, y) =>
      Array.from({ length: w }, (_, x) => [
        (x * 37 + y * 11) & 0xff,
        (x * 5 + y * 71) & 0xff,
        (x * y * 13 + 7) & 0xff,
        (x + y) % 3 === 0 ? 255 : (x * 29) & 0xff,
      ]),
  );
}

const flatten = (s: number[][][]) => s.flat(2);

Deno.test("RGBA8 round-trips through every filter type, plain and interlaced", async () => {
  const samples = rgbaImage(11, 9);
  for (const interlace of [false, true]) {
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = await encodePng({
        width: 11,
        height: 9,
        colorType: 6,
        depth: 8,
        samples,
        filter,
        interlace,
      });
      const d = await decodePng(png);
      assertEquals([d.width, d.height], [11, 9]);
      assertEquals(Array.from(d.data), flatten(samples), `f=${filter}`);
    }
  }
});

Deno.test("16-bit RGB is reduced to 8-bit with opaque alpha", async () => {
  const samples = [[[0xffff, 0x8000, 0x00ff], [0x1234, 0, 0xabcd]]];
  const d = await decodePng(
    await encodePng({ width: 2, height: 1, colorType: 2, depth: 16, samples }),
  );
  assertEquals(Array.from(d.data), [255, 128, 0, 255, 0x12, 0, 0xab, 255]);
});

Deno.test("low bit-depth greyscale is unpacked and scaled, interlaced too", async () => {
  for (const depth of [1, 2, 4]) {
    const max = (1 << depth) - 1;
    const samples = Array.from(
      { length: 5 },
      (_, y) => Array.from({ length: 7 }, (_, x) => [(x + y) % (max + 1)]),
    );
    for (const interlace of [false, true]) {
      const d = await decodePng(
        await encodePng({
          width: 7,
          height: 5,
          colorType: 0,
          depth,
          samples,
          interlace,
          filter: 1,
        }),
      );
      const expected = samples.flat().flatMap(([v]) => {
        const g = Math.round(v * 255 / max);
        return [g, g, g, 255];
      });
      assertEquals(Array.from(d.data), expected, `depth=${depth}`);
    }
  }
});

Deno.test("indexed colour with tRNS palette alpha", async () => {
  const d = await decodePng(
    await encodePng({
      width: 3,
      height: 1,
      colorType: 3,
      depth: 2,
      samples: [[[0], [1], [2]]],
      palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
      trns: new Uint8Array([255, 0]),
    }),
  );
  assertEquals(Array.from(d.data), [
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    0,
    0,
    0,
    255,
    255,
  ]);
});

Deno.test("truecolour and greyscale tRNS colour keys become transparent", async () => {
  const rgb = await decodePng(
    await encodePng({
      width: 2,
      height: 1,
      colorType: 2,
      depth: 8,
      samples: [[[1, 2, 3], [9, 9, 9]]],
      trns: new Uint8Array([0, 9, 0, 9, 0, 9]),
    }),
  );
  assertEquals(Array.from(rgb.data), [1, 2, 3, 255, 9, 9, 9, 0]);
  const grey = await decodePng(
    await encodePng({
      width: 2,
      height: 1,
      colorType: 0,
      depth: 8,
      samples: [[[0], [200]]],
      trns: new Uint8Array([0, 0]),
    }),
  );
  assertEquals(Array.from(grey.data), [0, 0, 0, 0, 200, 200, 200, 255]);
});

Deno.test("greyscale + alpha", async () => {
  const d = await decodePng(
    await encodePng({
      width: 1,
      height: 1,
      colorType: 4,
      depth: 8,
      samples: [[[100, 50]]],
    }),
  );
  assertEquals(Array.from(d.data), [100, 100, 100, 50]);
});

Deno.test("rejects non-PNG, truncated and malformed input", async () => {
  await assertRejects(
    () => decodePng(new TextEncoder().encode("GIF89a")),
    Error,
    "Not a PNG",
  );
  const good = await encodePng({
    width: 2,
    height: 2,
    colorType: 6,
    depth: 8,
    samples: rgbaImage(2, 2),
  });
  await assertRejects(
    () => decodePng(good.subarray(0, good.length - 20)),
    Error,
    "Invalid PNG",
  );
  // Corrupt the bit depth in IHDR (offset 8 sig + 8 chunk header + 8).
  const badDepth = good.slice();
  badDepth[24] = 3;
  await assertRejects(() => decodePng(badDepth), Error, "bit depth 3");
  // Indexed image without a palette.
  const noPalette = await encodePng({
    width: 1,
    height: 1,
    colorType: 3,
    depth: 8,
    samples: [[[0]]],
  });
  await assertRejects(() => decodePng(noPalette), Error, "without PLTE");
  // Palette index out of range.
  const badIndex = await encodePng({
    width: 1,
    height: 1,
    colorType: 3,
    depth: 8,
    samples: [[[5]]],
    palette: [[1, 2, 3]],
  });
  await assertRejects(() => decodePng(badIndex), Error, "out of range");
});

Deno.test("rejects images over the pixel cap from the header alone", async () => {
  const png = await encodePng({
    width: 1,
    height: 1,
    colorType: 6,
    depth: 8,
    samples: [[[0, 0, 0, 0]]],
  });
  const huge = png.slice();
  const dv = new DataView(huge.buffer);
  dv.setUint32(16, 100000);
  dv.setUint32(20, 100000);
  await assertRejects(() => decodePng(huge), Error, "too large");
});

Deno.test("refuses image data that inflates past the expected size", async () => {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 1);
  dv.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const bomb = concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(new Uint8Array(1_000_000))),
    chunk("IEND", new Uint8Array()),
  ]);
  await assertRejects(() => decodePng(bomb), Error, "exceeds expected");
});
