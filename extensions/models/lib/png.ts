// Minimal, dependency-free PNG decoder for the drawImage method.
//
// Supports every colour type and bit depth in the PNG spec (greyscale,
// truecolour, indexed, greyscale+alpha, truecolour+alpha at 1/2/4/8/16 bits),
// tRNS transparency (palette alpha and greyscale/truecolour colour keys) and
// Adam7 interlacing. Output is always 8-bit RGBA. Ancillary chunks other than
// tRNS are ignored; CRCs are not verified (a corrupt stream fails in inflate
// or in the size checks below).

/** Decoded image: `data` is `width * height * 4` bytes of 8-bit RGBA. */
export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Hard cap on decoded pixels, so a hostile header can't exhaust memory. */
export const MAX_PNG_PIXELS = 4096 * 4096;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Channels per colour type, and the bit depths the spec allows for each.
const COLOR_TYPES: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** zlib-inflate `data`, refusing to produce more than `limit` bytes. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate"),
  ).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        throw new Error(`decompressed data exceeds expected ${limit} bytes`);
      }
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverse one scanline's filter in place. `prev` is the unfiltered row above. */
function unfilter(
  type: number,
  line: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): void {
  for (let i = 0; i < line.length; i++) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0:
        return;
      case 1:
        line[i] = (line[i] + left) & 0xff;
        break;
      case 2:
        line[i] = (line[i] + up) & 0xff;
        break;
      case 3:
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
        break;
      case 4:
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Invalid PNG: unknown filter type ${type}`);
    }
  }
}

/** Decode a PNG file into 8-bit RGBA. Throws a descriptive Error on bad input. */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (
    bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)
  ) {
    throw new Error("Not a PNG file (bad signature)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let sawEnd = false;

  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const start = off + 8;
    const end = start + len;
    if (end + 4 > bytes.length) {
      throw new Error(`Invalid PNG: ${type} chunk runs past end of file`);
    }
    const body = bytes.subarray(start, end);
    if (type === "IHDR") {
      if (len !== 13) throw new Error("Invalid PNG: bad IHDR length");
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      depth = body[8];
      colorType = body[9];
      if (body[10] !== 0 || body[11] !== 0) {
        throw new Error("Invalid PNG: unsupported compression/filter method");
      }
      interlace = body[12];
      if (interlace > 1) throw new Error("Invalid PNG: bad interlace method");
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      trns = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    off = end + 4;
  }

  const ct = COLOR_TYPES[colorType];
  if (!ct) throw new Error(`Invalid PNG: missing IHDR or bad colour type`);
  if (!ct.depths.includes(depth)) {
    throw new Error(
      `Invalid PNG: bit depth ${depth} not allowed for colour type ${colorType}`,
    );
  }
  if (width < 1 || height < 1) throw new Error("Invalid PNG: empty image");
  if (width * height > MAX_PNG_PIXELS) {
    throw new Error(
      `PNG too large: ${width}x${height} exceeds ${MAX_PNG_PIXELS} pixels`,
    );
  }
  if (colorType === 3 && !palette) {
    throw new Error("Invalid PNG: indexed image without PLTE");
  }
  if (!sawEnd || idat.length === 0) {
    throw new Error("Invalid PNG: missing IDAT or IEND (truncated file?)");
  }

  let compressed: Uint8Array;
  if (idat.length === 1) {
    compressed = idat[0];
  } else {
    compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of idat) {
      compressed.set(c, p);
      p += c.length;
    }
  }
  const { channels } = ct;
  const bitsPerPixel = channels * depth;
  const passes = interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) {
      expected += ph * (1 + Math.ceil(pw * bitsPerPixel / 8));
    }
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(compressed, expected);
  } catch (e) {
    throw new Error(
      `Invalid PNG: image data failed to decompress (${(e as Error).message})`,
    );
  }

  const bpp = Math.max(1, bitsPerPixel >> 3);
  const maxSample = (1 << depth) - 1;
  const out = new Uint8Array(width * height * 4);

  // tRNS colour key for greyscale/truecolour, compared on raw sample values.
  let key: number[] | null = null;
  if (trns && (colorType === 0 || colorType === 2)) {
    const tv = new DataView(trns.buffer, trns.byteOffset, trns.byteLength);
    const need = colorType === 0 ? 1 : 3;
    if (trns.length >= need * 2) {
      key = [];
      for (let i = 0; i < need; i++) key.push(tv.getUint16(i * 2));
    }
  }

  const to8 = (v: number) =>
    depth === 16 ? v >> 8 : depth === 8 ? v : Math.round(v * 255 / maxSample);

  let pos = 0;
  const samples = new Array<number>(channels);
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil(pw * bitsPerPixel / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < ph; row++) {
      if (pos + 1 + stride > raw.length) {
        throw new Error("Invalid PNG: image data is truncated");
      }
      const filter = raw[pos];
      const line = raw.slice(pos + 1, pos + 1 + stride);
      pos += 1 + stride;
      unfilter(filter, line, prev, bpp);
      prev = line;
      const y = y0 + row * dy;
      for (let col = 0; col < pw; col++) {
        for (let c = 0; c < channels; c++) {
          if (depth === 16) {
            const i = (col * channels + c) * 2;
            samples[c] = (line[i] << 8) | line[i + 1];
          } else if (depth === 8) {
            samples[c] = line[col * channels + c];
          } else {
            const bit = (col * channels + c) * depth;
            samples[c] = (line[bit >> 3] >> (8 - depth - (bit & 7))) &
              maxSample;
          }
        }
        const o = ((y * width) + x0 + col * dx) * 4;
        let r: number, g: number, b: number, a = 255;
        if (colorType === 3) {
          const idx = samples[0];
          if (idx * 3 + 2 >= palette!.length) {
            throw new Error(`Invalid PNG: palette index ${idx} out of range`);
          }
          r = palette![idx * 3];
          g = palette![idx * 3 + 1];
          b = palette![idx * 3 + 2];
          if (trns && idx < trns.length) a = trns[idx];
        } else if (colorType === 0 || colorType === 4) {
          r = g = b = to8(samples[0]);
          if (colorType === 4) a = to8(samples[1]);
          else if (key && samples[0] === key[0]) a = 0;
        } else {
          r = to8(samples[0]);
          g = to8(samples[1]);
          b = to8(samples[2]);
          if (colorType === 6) a = to8(samples[3]);
          else if (
            key && samples[0] === key[0] && samples[1] === key[1] &&
            samples[2] === key[2]
          ) a = 0;
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
  }
  return { width, height, data: out };
}
