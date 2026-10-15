// Image → Minecraft block art helpers for the drawImage method.
// No type annotations here: lib/ files are loaded as potential models.
import pngjs from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

// Average texture colors of solid, non-gravity, non-valuable blocks.
const PALETTE = [
  ["white_concrete", 207, 213, 214],
  ["orange_concrete", 224, 97, 1],
  ["magenta_concrete", 169, 48, 159],
  ["light_blue_concrete", 36, 137, 199],
  ["yellow_concrete", 241, 175, 21],
  ["lime_concrete", 94, 169, 24],
  ["pink_concrete", 214, 101, 143],
  ["gray_concrete", 55, 58, 62],
  ["light_gray_concrete", 125, 125, 115],
  ["cyan_concrete", 21, 119, 136],
  ["purple_concrete", 100, 32, 156],
  ["blue_concrete", 45, 47, 143],
  ["brown_concrete", 96, 60, 32],
  ["green_concrete", 73, 91, 36],
  ["red_concrete", 142, 33, 33],
  ["black_concrete", 8, 10, 15],
  ["white_wool", 234, 236, 237],
  ["orange_wool", 241, 118, 20],
  ["magenta_wool", 190, 69, 180],
  ["light_blue_wool", 58, 175, 217],
  ["yellow_wool", 249, 198, 40],
  ["lime_wool", 112, 185, 26],
  ["pink_wool", 238, 141, 172],
  ["gray_wool", 63, 68, 72],
  ["light_gray_wool", 142, 142, 135],
  ["cyan_wool", 21, 138, 145],
  ["purple_wool", 122, 42, 173],
  ["blue_wool", 53, 57, 157],
  ["brown_wool", 114, 72, 41],
  ["green_wool", 85, 110, 28],
  ["red_wool", 161, 39, 35],
  ["black_wool", 21, 21, 26],
  ["terracotta", 152, 94, 68],
  ["white_terracotta", 210, 178, 161],
  ["orange_terracotta", 162, 84, 38],
  ["magenta_terracotta", 150, 88, 109],
  ["light_blue_terracotta", 113, 109, 138],
  ["yellow_terracotta", 186, 133, 35],
  ["lime_terracotta", 104, 118, 53],
  ["pink_terracotta", 162, 78, 79],
  ["gray_terracotta", 58, 42, 36],
  ["light_gray_terracotta", 135, 107, 98],
  ["cyan_terracotta", 87, 91, 91],
  ["purple_terracotta", 118, 70, 86],
  ["blue_terracotta", 74, 60, 91],
  ["brown_terracotta", 77, 51, 36],
  ["green_terracotta", 76, 83, 42],
  ["red_terracotta", 143, 61, 47],
  ["black_terracotta", 37, 23, 16],
];

function srgbToLab(r, g, b) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const PALETTE_LAB = PALETTE.map((
  [name, r, g, b],
) => [name, srgbToLab(r, g, b)]);

function nearestBlock(r, g, b) {
  const [L, A, B] = srgbToLab(r, g, b);
  let best = PALETTE_LAB[0][0];
  let bestD = Infinity;
  for (const [name, [l, a, bb]] of PALETTE_LAB) {
    const d = (L - l) ** 2 + (A - a) ** 2 + (B - bb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/**
 * Decode a PNG and box-downsample it to `width` columns (height keeps aspect).
 * Returns { width, height, grid } where grid[row][col] is a block id or null
 * (transparent: average alpha below alphaThreshold). Row 0 is the image top.
 */
export function imageToBlockGrid(pngBytes, width, alphaThreshold = 128) {
  const png = pngjs.PNG.sync.read(Buffer.from(pngBytes));
  const srcW = png.width, srcH = png.height, data = png.data;
  const height = Math.max(1, Math.round(srcH * width / srcW));
  const grid = [];
  for (let row = 0; row < height; row++) {
    const y0 = Math.floor(row * srcH / height);
    const y1 = Math.max(y0 + 1, Math.floor((row + 1) * srcH / height));
    const line = [];
    for (let col = 0; col < width; col++) {
      const x0 = Math.floor(col * srcW / width);
      const x1 = Math.max(x0 + 1, Math.floor((col + 1) * srcW / width));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcW + x) * 4;
          const alpha = data[i + 3];
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      if (a / n < alphaThreshold) {
        line.push(null);
      } else {
        line.push(nearestBlock(r / a, g / a, b / a));
      }
    }
    grid.push(line);
  }
  return { width, height, grid };
}

// Unit vectors for a viewer standing at the anchor looking toward `facing`.
const AXES = {
  north: { fwd: [0, 0, -1], right: [1, 0, 0] },
  south: { fwd: [0, 0, 1], right: [-1, 0, 0] },
  east: { fwd: [1, 0, 0], right: [0, 0, 1] },
  west: { fwd: [-1, 0, 0], right: [0, 0, -1] },
};

/** Snap a Minecraft yaw (0=south, 90=west, 180=north, -90=east) to a cardinal. */
export function yawToFacing(yaw) {
  const y = ((Math.round(yaw / 90) % 4) + 4) % 4;
  return ["south", "west", "north", "east"][y];
}

/**
 * Turn a block grid into run-length `fill` commands with absolute coords.
 * wall: upright, `distance` blocks in front of the anchor, bottom row at
 *       anchor y, centered on the anchor, readable from the anchor.
 * floor: flat at anchor y-1, starting `distance` blocks ahead, image top
 *        farthest away, readable when facing `facing`.
 */
export function gridToCommands(grid, anchor, facing, orientation, distance) {
  const { fwd, right } = AXES[facing];
  const width = grid[0].length, height = grid.length;
  const ax = Math.floor(anchor[0]),
    ay = Math.floor(anchor[1]),
    az = Math.floor(anchor[2]);
  const half = Math.floor(width / 2);
  const pos = (col, row) => {
    const c = col - half;
    if (orientation === "floor") {
      const f = distance + (height - 1 - row);
      return [
        ax + fwd[0] * f + right[0] * c,
        ay - 1,
        az + fwd[2] * f + right[2] * c,
      ];
    }
    return [
      ax + fwd[0] * distance + right[0] * c,
      ay + (height - 1 - row),
      az + fwd[2] * distance + right[2] * c,
    ];
  };
  const commands = [];
  const counts = {};
  let blocks = 0;
  for (let row = 0; row < height; row++) {
    let col = 0;
    while (col < width) {
      const block = grid[row][col];
      if (!block) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < width && grid[row][end + 1] === block) end++;
      const [x1, y1, z1] = pos(col, row);
      const [x2, y2, z2] = pos(end, row);
      commands.push(
        `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:${block}`,
      );
      counts[block] = (counts[block] || 0) + (end - col + 1);
      blocks += end - col + 1;
      col = end + 1;
    }
  }
  const corners = [pos(0, 0), pos(width - 1, height - 1)];
  return { commands, counts, blocks, corners };
}
