/**
 * Tests for the pure helpers in lib/minecraft.ts, lib/ssh.ts,
 * lib/metrics.ts and lib/pixelart.ts.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertSafePath,
  buildMcmeta,
  buildSendKeysCommand,
  functionDir,
  parsePackFormat,
  parsePlayerList,
  parsePlayerPose,
  parseVariables,
  sanitizeConsoleText,
  serverTargetErrors,
  validateDimension,
  validatePlayerName,
} from "./minecraft.ts";
import {
  assertSshTarget,
  buildSshArgs,
  isValidSshHost,
  quoteRemotePath,
  shellQuote,
} from "./ssh.ts";
import {
  buildMetricsCommand,
  escapeLabel,
  formatLogLine,
  formatPromMetrics,
} from "./metrics.ts";
import {
  gridToCommands,
  imageToBlockGrid,
  nearestBlock,
  yawToFacing,
} from "./pixelart.ts";

Deno.test("isValidSshHost treats empty and stringified nulls as absent", () => {
  for (const v of [null, undefined, "", "null", "undefined", 42]) {
    assertEquals(isValidSshHost(v), false);
  }
  assertEquals(isValidSshHost("192.0.2.1"), true);
});

Deno.test("buildSshArgs validates user/host and ends options with --", () => {
  const args = buildSshArgs("mc.example.com", "root", "echo ok");
  assertEquals(args.slice(-3), ["--", "root@mc.example.com", "echo ok"]);
  assertEquals(buildSshArgs("2001:db8::1", "u", "x").at(-2), "u@2001:db8::1");
  assertThrows(() => assertSshTarget("-oProxyCommand=x", "root"), Error);
  assertThrows(() => assertSshTarget("host name", "root"), Error);
  assertThrows(() => assertSshTarget("192.0.2.1", "-l"), Error, "sshUser");
  assertThrows(() => assertSshTarget("192.0.2.1", "a b"), Error, "sshUser");
});

Deno.test("shellQuote and quoteRemotePath", () => {
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
  assertEquals(quoteRemotePath("~/a b/c"), `"$HOME"/'a b/c'`);
  assertEquals(quoteRemotePath("/srv/x"), `'/srv/x'`);
  assertEquals(quoteRemotePath("~"), `"$HOME"`);
});

Deno.test("safe path / session / name validation", () => {
  assertSafePath("serverDir", "~/mons");
  assertSafePath("logPath", "/opt/mc/logs/latest.log");
  for (const bad of ["~/a b", "x;y", "$(id)", "`id`", "-rf", "a'b", ""]) {
    assertThrows(() => assertSafePath("p", bad), Error, "Invalid p");
  }
  const ok = {
    sshHost: null,
    sshUser: "root",
    tmuxSession: "mons",
    serverDir: "~/mons",
    startScript: "./startserver.sh",
    logPath: "~/mons/logs/latest.log",
    serverName: "mons",
  };
  assertEquals(serverTargetErrors(ok), []);
  assertEquals(serverTargetErrors({ ...ok, sshHost: "192.0.2.5" }), []);
  assertEquals(serverTargetErrors({ ...ok, sshHost: "-oX=y" }).length, 1);
  assertEquals(
    serverTargetErrors({
      ...ok,
      tmuxSession: "a.b",
      serverName: "x y",
      sshUser: "-x",
    }).length,
    3,
  );
});

Deno.test("player names and dimensions", () => {
  assertEquals(validatePlayerName("Notch"), "Notch");
  assertThrows(() => validatePlayerName("a b"), Error);
  assertThrows(() => validatePlayerName(""), Error);
  assertEquals(
    validateDimension("minecraft:the_nether"),
    "minecraft:the_nether",
  );
  assertThrows(() => validateDimension("overworld"), Error);
  assertThrows(() => validateDimension("minecraft:x run stop"), Error);
});

Deno.test("buildSendKeysCommand quotes literal text and strips control chars", () => {
  assertEquals(sanitizeConsoleText(" a\nb\t "), "a b");
  assertEquals(
    buildSendKeysCommand("mons", ["say hi", "list"]),
    "tmux send-keys -t mons -l 'say hi' && tmux send-keys -t mons Enter && " +
      "tmux send-keys -t mons -l 'list' && tmux send-keys -t mons Enter",
  );
  assertThrows(() => buildSendKeysCommand("a;b", ["x"]), Error);
});

Deno.test("parsePlayerList", () => {
  assertEquals(
    parsePlayerList(
      "[INFO]: There are 3 of a max of 20 players online: a, b ,c\n",
    ),
    { online: 3, max: 20, players: ["a", "b", "c"] },
  );
  assertEquals(
    parsePlayerList("There are 0 of a max of 8 players online:"),
    { online: 0, max: 8, players: [] },
  );
  assertEquals(parsePlayerList("garbage"), null);
});

Deno.test("parsePlayerPose", () => {
  const log = [
    "Steve has the following entity data: [10.5d, 64.0d, -3.25d]",
    "Steve has the following entity data: [-91.5f, 12.0f]",
    'Steve has the following entity data: "minecraft:the_nether"',
  ].join("\n");
  assertEquals(parsePlayerPose(log), {
    pos: [10.5, 64, -3.25],
    yaw: -91.5,
    dimension: "minecraft:the_nether",
  });
  assertEquals(parsePlayerPose("No entity was found"), null);
});

Deno.test("parsePackFormat handles numeric and object forms", () => {
  assertEquals(parsePackFormat('{"pack_version": 48}'), 48);
  assertEquals(parsePackFormat('{"pack_version": {"data": 61}}'), 61);
  assertEquals(
    parsePackFormat('{"pack_version": {"data_major": 88, "data": 1}}'),
    88,
  );
  assertThrows(() => parsePackFormat("{}"), Error, "pack_version");
  assertThrows(() => parsePackFormat("not json"), Error);
});

Deno.test("mcmeta and function dir by pack format", () => {
  assertEquals(buildMcmeta(48), {
    pack: { description: "swampdraw", pack_format: 48 },
  });
  assertEquals(buildMcmeta(88), {
    pack: { description: "swampdraw", min_format: 88, max_format: 88 },
  });
  assertEquals(functionDir(44), "functions");
  assertEquals(functionDir(45), "function");
});

Deno.test("parseVariables", () => {
  assertEquals(
    parseVariables(
      'MODLOADER=Fabric\nMINECRAFT_VERSION="1.20.1"\nMODLOADER_VERSION=0.15.7\n',
    ),
    { modloader: "Fabric", mcVersion: "1.20.1", modloaderVersion: "0.15.7" },
  );
  assertEquals(parseVariables(""), {
    modloader: "",
    mcVersion: "",
    modloaderVersion: "",
  });
});

Deno.test("metrics formatting escapes labels and omits unknown max", () => {
  assertEquals(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const prom = formatPromMetrics("minecraft", "mons", {
    serverRunning: true,
    online: 2,
    max: null,
    players: ["a", "b"],
  }, 1_700_000_000_000);
  assertStringIncludes(
    prom,
    'game_players_online{game="minecraft",server="mons"} 2',
  );
  assert(!prom.includes("game_players_max"));
  assertStringIncludes(prom, "} 1700000000\n");
  const line = formatLogLine("minecraft", "mons", {
    serverRunning: false,
    online: 0,
    max: 10,
    players: [],
  }, new Date(0));
  assertEquals(JSON.parse(line).ts, "1970-01-01T00:00:00.000Z");
  const cmd = buildMetricsCommand("minecraft", "x 1\n", `{"p":"it's"}`);
  assertStringIncludes(
    cmd,
    `printf '%s\\n' '{"p":"it'\\''s"}' >> /var/log/game-players.log`,
  );
  assertThrows(() => buildMetricsCommand("mine craft", "", ""), Error);
});

Deno.test("yawToFacing snaps to cardinals", () => {
  assertEquals(yawToFacing(0), "south");
  assertEquals(yawToFacing(90), "west");
  assertEquals(yawToFacing(180), "north");
  assertEquals(yawToFacing(-90), "east");
  assertEquals(yawToFacing(-181), "north");
  assertEquals(yawToFacing(44), "south");
});

Deno.test("nearestBlock picks exact palette colours", () => {
  assertEquals(nearestBlock(207, 213, 214), "white_concrete");
  assertEquals(nearestBlock(8, 10, 15), "black_concrete");
});

Deno.test("gridToCommands run-length encodes rows on a north-facing wall", () => {
  const grid = [
    ["red_wool", "red_wool", null],
    [null, "blue_wool", "blue_wool"],
  ];
  const r = gridToCommands(grid, [0.5, 64, 0.5], "north", "wall", 5);
  assertEquals(r.commands, [
    "fill -1 65 -5 0 65 -5 minecraft:red_wool",
    "fill 0 64 -5 1 64 -5 minecraft:blue_wool",
  ]);
  assertEquals(r.blocks, 4);
  assertEquals(r.counts, { red_wool: 2, blue_wool: 2 });
  assertEquals(r.corners, [[-1, 65, -5], [1, 64, -5]]);
});

Deno.test("gridToCommands floor orientation puts the image top farthest away", () => {
  const r = gridToCommands([["a"], ["b"]], [0, 70, 0], "east", "floor", 3);
  assertEquals(r.commands, [
    "fill 4 69 0 4 69 0 minecraft:a",
    "fill 3 69 0 3 69 0 minecraft:b",
  ]);
});

async function solidPng(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): Promise<Uint8Array> {
  // Uncompressed-by-filter RGBA8 PNG built with the platform deflate.
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(rgba, y * (1 + w * 4) + 1 + x * 4);
  }
  const z = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out; // CRC left zero: the decoder does not verify CRCs
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", z),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

Deno.test("imageToBlockGrid downsamples and keeps aspect ratio", async () => {
  const png = await solidPng(8, 4, [207, 213, 214, 255]);
  const { width, height, grid } = await imageToBlockGrid(png, 4);
  assertEquals([width, height], [4, 2]);
  assert(grid.flat().every((b) => b === "white_concrete"));
});

Deno.test("imageToBlockGrid leaves transparent pixels as null", async () => {
  const png = await solidPng(2, 2, [255, 0, 0, 10]);
  const { grid } = await imageToBlockGrid(png, 2, 128);
  assertEquals(grid, [[null, null], [null, null]]);
});

Deno.test("imageToBlockGrid refuses absurdly tall art", async () => {
  const png = await solidPng(1, 4000, [0, 0, 0, 255]);
  await assertRejects(() => imageToBlockGrid(png, 1), Error, "blocks tall");
});
