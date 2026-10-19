/**
 * Unit tests for the `@keeb/minecraft/server` model. ssh is mocked with
 * `withMockedCommand`; each test routes remote command strings to canned
 * output and asserts on what was sent and what was written.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import {
  model,
  type ServerContext,
  type ServerGlobalArgs,
} from "./minecraft_server.ts";

type Route = [RegExp, { stdout?: string; stderr?: string; code?: number }];

const BASE: ServerGlobalArgs = {
  sshHost: "192.0.2.10",
  sshUser: "root",
  tmuxSession: "mons",
  serverDir: "~/mons",
  startScript: "./startserver.sh",
  logPath: "~/mons/logs/latest.log",
  serverName: "mons",
};

function setup(globalArgs: Partial<ServerGlobalArgs> = {}) {
  const t = createModelTestContext({
    globalArgs: { ...BASE, ...globalArgs },
  });
  return { ...t, ctx: t.context as unknown as ServerContext };
}

/** Run `fn` with ssh mocked: the remote command (last argv) picks a route. */
function withSsh<T>(routes: Route[], fn: () => Promise<T>) {
  return withMockedCommand((cmd, args) => {
    if (cmd !== "ssh") return { stdout: "", stderr: "unexpected", code: 127 };
    const remote = args[args.length - 1];
    for (const [re, out] of routes) {
      if (re.test(remote)) {
        return {
          stdout: out.stdout ?? "",
          stderr: out.stderr ?? "",
          code: out.code ?? 0,
        };
      }
    }
    return { stdout: "", code: 0 };
  }, fn);
}

const remoteCommands = (calls: { args: string[] }[]) =>
  calls.map((c) => c.args[c.args.length - 1]);

const TMUX_UP: Route = [/tmux has-session/, { stdout: "exists\n" }];
const TMUX_DOWN: Route = [/tmux has-session/, { stdout: "missing\n" }];

Deno.test("model is a plain catalogable object with a matching upgrade", () => {
  assertEquals(model.type, "@keeb/minecraft/server");
  assertEquals(
    model.upgrades[model.upgrades.length - 1].toVersion,
    model.version,
  );
  const old = { sshHost: "198.51.100.1" };
  assertEquals(model.upgrades[0].upgradeAttributes(old), old);
});

Deno.test("valid-server-target check passes defaults and rejects shell metacharacters", async () => {
  const check = model.checks["valid-server-target"];
  assertEquals(await check.execute({ globalArgs: BASE }), { pass: true });
  const bad = await check.execute({
    globalArgs: { ...BASE, serverDir: "~/mons; rm -rf /", tmuxSession: "a b" },
  });
  assertEquals(bad.pass, false);
  assertEquals(bad.errors?.length, 2);
});

Deno.test("say: skips without sshHost and makes no ssh calls", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: null });
  const { calls } = await withSsh(
    [],
    () => model.methods.say.execute({ message: "hi" }, ctx),
  );
  assertEquals(calls.length, 0);
  assertEquals(getWrittenResources()[0].data, { success: true, skipped: true });
});

Deno.test("say: skips when the tmux session is missing", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh(
    [TMUX_DOWN],
    () => model.methods.say.execute({ message: "hi" }, ctx),
  );
  assertEquals(calls.length, 1);
  assertEquals(getWrittenResources()[0].data.skipped, true);
});

Deno.test("say: quotes the message so apostrophes cannot break the shell", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh(
    [TMUX_UP],
    () =>
      model.methods.say.execute(
        { message: "don't stop; reboot\nnow" },
        ctx,
      ),
  );
  const send = remoteCommands(calls)[1];
  assertEquals(
    send,
    `tmux send-keys -t mons -l 'say don'\\''t stop; reboot now' && tmux send-keys -t mons Enter`,
  );
  assertEquals(calls[1].args.includes("--"), true);
  assertEquals(getWrittenResources()[0].data, {
    success: true,
    skipped: false,
  });
});

Deno.test("say: empty message is rejected before any ssh call", async () => {
  const { ctx } = setup();
  await assertRejects(
    () => model.methods.say.execute({ message: "  " }, ctx),
    Error,
    "message is required",
  );
});

Deno.test("say: a failing send-keys fails the method instead of reporting success", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh(
    [TMUX_UP, [/send-keys/, { code: 1, stderr: "no server running" }]],
    async () => {
      await assertRejects(
        () => model.methods.say.execute({ message: "hi" }, ctx),
        Error,
        "no server running",
      );
    },
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("op/deop: send the validated player name", async () => {
  for (const method of ["op", "deop"] as const) {
    const { ctx } = setup();
    const { calls } = await withSsh(
      [TMUX_UP],
      () => model.methods[method].execute({ playerName: "Steve_01" }, ctx),
    );
    assertStringIncludes(remoteCommands(calls)[1], `-l '${method} Steve_01'`);
  }
});

Deno.test("op: invalid or missing player names are rejected", async () => {
  const { ctx } = setup();
  await assertRejects(
    () => model.methods.op.execute({ playerName: "" }, ctx),
    Error,
    "playerName is required",
  );
  await assertRejects(
    () => model.methods.op.execute({ playerName: "bob;stop" }, ctx),
    Error,
    "Invalid playerName",
  );
  await assertRejects(
    () => model.methods.deop.execute({ playerName: "a".repeat(17) }, ctx),
    Error,
    "Invalid playerName",
  );
});

Deno.test("invalid global arguments fail before any ssh call", async () => {
  const { ctx } = setup({ tmuxSession: "mons;reboot" });
  const { calls } = await withSsh([TMUX_UP], async () => {
    await assertRejects(
      () => model.methods.say.execute({ message: "hi" }, ctx),
      Error,
      "Invalid tmuxSession",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("ssh option injection via sshUser is rejected", async () => {
  const { ctx } = setup({ sshUser: "-oProxyCommand=touch /tmp/pwn" });
  const { calls } = await withSsh([TMUX_UP], async () => {
    await assertRejects(
      () => model.methods.status.execute({}, ctx),
      Error,
      "sshUser",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("status: parses the player list", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_UP,
    [/wc -l/, { stdout: "41\n" }],
    [/tail -n \+42 /, {
      stdout:
        "[12:00:00] [Server thread/INFO]: There are 2 of a max of 20 players online: alice, bob\n",
    }],
  ], () => model.methods.status.execute({}, ctx));
  const data = getWrittenResources()[0].data;
  assertEquals(data.serverRunning, true);
  assertEquals(data.online, 2);
  assertEquals(data.max, 20);
  assertEquals(data.players, ["alice", "bob"]);
});

Deno.test("status: unparseable list writes null counts", async () => {
  const { ctx, getWrittenResources, getLogsByLevel } = setup();
  await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_UP,
    [/wc -l/, { stdout: "0\n" }],
  ], () => model.methods.status.execute({}, ctx));
  const data = getWrittenResources()[0].data;
  assertEquals(data.serverRunning, true);
  assertEquals(data.online, null);
  assertEquals(getLogsByLevel("warning").length, 1);
});

Deno.test("status: unreachable host reports not running", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh(
    [[/echo ok/, { code: 255, stderr: "Connection timed out" }]],
    () => model.methods.status.execute({}, ctx),
  );
  assertEquals(getWrittenResources()[0].data.serverRunning, false);
});

Deno.test("stopMinecraftServer: already stopped when no tmux and no java", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_DOWN,
    [/pgrep -f '\[j\]ava' >/, { stdout: "stopped\n" }],
  ], () => model.methods.stopMinecraftServer.execute({}, ctx));
  assertEquals(getWrittenResources()[0].data.alreadyStopped, true);
  assert(!remoteCommands(calls).some((c) => c.includes("send-keys")));
});

Deno.test("stopMinecraftServer: sends stop, waits for the pid, kills tmux", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_UP,
    [/pgrep -f '\[j\]ava' >/, { stdout: "running\n" }],
    [/pgrep -f '\[j\]ava\.\*neoforge'/, { stdout: "4242\n" }],
    [/kill -0 4242/, { stdout: "stopped\n" }],
  ], () => model.methods.stopMinecraftServer.execute({}, ctx));
  const cmds = remoteCommands(calls);
  assert(cmds.some((c) => c.includes("-l 'stop'")));
  assertEquals(
    cmds[cmds.length - 1],
    "tmux kill-session -t mons 2>/dev/null || true",
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.alreadyStopped, false);
  assertEquals(data.timedOut, false);
  assertEquals(data.ip, "192.0.2.10");
});

Deno.test("startMinecraftServer: requires sshHost", async () => {
  const { ctx } = setup({ sshHost: null });
  await assertRejects(
    () => model.methods.startMinecraftServer.execute({}, ctx),
    Error,
    "sshHost is required",
  );
});

Deno.test("startMinecraftServer: starts tmux and waits for Done", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh([
    [/echo ready/, { stdout: "ready\n" }],
    [/grep -q/, { stdout: "READY\n" }],
  ], () => model.methods.startMinecraftServer.execute({}, ctx));
  const start = remoteCommands(calls).find((c) =>
    c.startsWith("tmux new-session")
  );
  assertEquals(
    start,
    "tmux new-session -d -s mons -c ~/mons 'bash ./startserver.sh 2>&1 | tee /tmp/mc-start-mons.log'",
  );
  assertEquals(getWrittenResources()[0].data.serverReady, true);
});

Deno.test("startMinecraftServer: fails fast when the tmux session dies", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh([
    [/echo ready/, { stdout: "ready\n" }],
    [/grep -q/, { stdout: "WAITING\n" }],
    [/tmux has-session/, { stdout: "missing\n" }],
    [/^cat /, { stdout: "Error: Unable to access jarfile\n" }],
  ], async () => {
    await assertRejects(
      () => model.methods.startMinecraftServer.execute({}, ctx),
      Error,
      "Unable to access jarfile",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("startMinecraftServer: tmux start failure is reported", async () => {
  const { ctx } = setup();
  await withSsh([
    [/echo ready/, { stdout: "ready\n" }],
    [/tmux new-session/, { code: 1, stderr: "duplicate session" }],
  ], async () => {
    await assertRejects(
      () => model.methods.startMinecraftServer.execute({}, ctx),
      Error,
      "duplicate session",
    );
  });
});

Deno.test("collectMetrics: writes prom + log files and the metrics resource", async () => {
  const { ctx, getWrittenResources } = setup();
  const { calls } = await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_UP,
    [/wc -l/, { stdout: "5\n" }],
    [/tail -n \+6 /, {
      stdout: "There are 1 of a max of 10 players online: alice\n",
    }],
  ], () => model.methods.collectMetrics.execute({}, ctx));
  const write = remoteCommands(calls).find((c) =>
    c.includes("textfile_collector")
  );
  assert(write);
  assertStringIncludes(
    write,
    'game_players_online{game="minecraft",server="mons"} 1',
  );
  const r = getWrittenResources()[0];
  assertEquals(r.specName, "metrics");
  assertEquals(r.data.online, 1);
  assertEquals(r.data.players, ["alice"]);
});

Deno.test("collectMetrics: offline host writes zeros without ssh writes", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: "null" });
  const { calls } = await withSsh(
    [],
    () => model.methods.collectMetrics.execute({}, ctx),
  );
  assertEquals(calls.length, 0);
  assertEquals(getWrittenResources()[0].data.serverRunning, false);
  assertEquals(getWrittenResources()[0].data.online, 0);
});

Deno.test("collectMetrics: a failed metrics write fails the method", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh([
    [/echo ok/, { stdout: "ok\n" }],
    TMUX_DOWN,
    [/textfile_collector/, { code: 1, stderr: "Permission denied" }],
  ], async () => {
    await assertRejects(
      () => model.methods.collectMetrics.execute({}, ctx),
      Error,
      "Permission denied",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("warnShutdown: skips when the server is not running", async () => {
  const { ctx, getWrittenResources } = setup();
  await withSsh(
    [TMUX_DOWN],
    () => model.methods.warnShutdown.execute({}, ctx),
  );
  assertEquals(getWrittenResources()[0].data.skipped, true);
});

Deno.test("drawImage: argument validation happens before ssh", async () => {
  const { ctx } = setup();
  const base = {
    imagePath: "/tmp/art.png",
    width: 64,
    anchorPlayer: "",
    x: null,
    y: null,
    z: null,
    facing: "" as const,
    dimension: "minecraft:overworld",
    orientation: "wall" as const,
    distance: 10,
    alphaThreshold: 128,
    name: "draw",
    packFormat: 0,
  };
  const { calls } = await withSsh([TMUX_UP], async () => {
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, imagePath: "" }, ctx),
      Error,
      "imagePath is required",
    );
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, width: 0 }, ctx),
      Error,
      "width must be 1-512",
    );
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, width: NaN }, ctx),
      Error,
      "width must be 1-512",
    );
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, distance: 0 }, ctx),
      Error,
      "distance must be >= 1",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("drawImage: needs an anchor, a facing and a valid dimension", async () => {
  const { ctx } = setup();
  const base = {
    imagePath: "/tmp/art.png",
    width: 8,
    anchorPlayer: "",
    x: 0,
    y: 64,
    z: 0,
    facing: "north" as const,
    dimension: "minecraft:overworld",
    orientation: "wall" as const,
    distance: 10,
    alphaThreshold: 128,
    name: "draw",
    packFormat: 0,
  };
  await withSsh([TMUX_UP], async () => {
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, x: null }, ctx),
      Error,
      "Provide anchorPlayer or all of x, y, z",
    );
    await assertRejects(
      () => model.methods.drawImage.execute({ ...base, facing: "" }, ctx),
      Error,
      "facing is required",
    );
    await assertRejects(
      () =>
        model.methods.drawImage.execute(
          { ...base, dimension: "overworld; stop" },
          ctx,
        ),
      Error,
      "Invalid dimension",
    );
  });
});

/** Solid-colour RGBA8 PNG (CRCs left zero: the decoder does not check them). */
async function solidPng(
  w: number,
  h: number,
  rgba: number[],
): Promise<Uint8Array> {
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
    return out;
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
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

async function withPng<T>(
  rgba: number[],
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/art.png`;
  await Deno.writeFile(path, await solidPng(4, 2, rgba));
  try {
    return await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const DRAW_ARGS = {
  imagePath: "",
  width: 4,
  anchorPlayer: "",
  x: 0,
  y: 64,
  z: 0,
  facing: "north" as const,
  dimension: "minecraft:overworld",
  orientation: "wall" as const,
  distance: 10,
  alphaThreshold: 128,
  name: "Logo Art",
  packFormat: 48,
};

Deno.test("drawImage: missing tmux session is an error, not a skip", async () => {
  await withPng([207, 213, 214, 255], async (imagePath) => {
    const { ctx } = setup();
    await withSsh([TMUX_DOWN], async () => {
      const err = await assertRejects(() =>
        model.methods.drawImage.execute({ ...DRAW_ARGS, imagePath }, ctx)
      );
      assertMatch((err as Error).message, /No tmux session mons/);
    });
  });
});

Deno.test("drawImage: a fully transparent image fails before touching the server", async () => {
  await withPng([0, 0, 0, 0], async (imagePath) => {
    const { ctx } = setup();
    const { calls } = await withSsh([TMUX_UP], async () => {
      await assertRejects(
        () => model.methods.drawImage.execute({ ...DRAW_ARGS, imagePath }, ctx),
        Error,
        "nothing to draw",
      );
    });
    assertEquals(calls.length, 0);
  });
});

/**
 * Deno.Command mock that also supports spawn() (sshWriteFile pipes stdin).
 * Records every remote command and the stdin written to spawned processes.
 */
async function withSpawnableSsh<T>(
  respond: (remote: string) => { stdout?: string; code?: number },
  fn: () => Promise<T>,
) {
  const calls: { remote: string; stdin?: string }[] = [];
  const enc = new TextEncoder();
  const result = (remote: string) => {
    const r = respond(remote);
    return {
      code: r.code ?? 0,
      success: (r.code ?? 0) === 0,
      signal: null,
      stdout: enc.encode(r.stdout ?? ""),
      stderr: new Uint8Array(),
    };
  };
  const Original = Deno.Command;
  class MockCommand {
    #remote: string;
    constructor(_cmd: string, opts: { args: string[] }) {
      this.#remote = opts.args[opts.args.length - 1];
    }
    output() {
      calls.push({ remote: this.#remote });
      return Promise.resolve(result(this.#remote));
    }
    spawn() {
      const call: { remote: string; stdin?: string } = {
        remote: this.#remote,
        stdin: "",
      };
      calls.push(call);
      const dec = new TextDecoder();
      const stdin = new WritableStream<Uint8Array>({
        write(chunk) {
          call.stdin += dec.decode(chunk);
        },
      });
      const remote = this.#remote;
      return { stdin, output: () => Promise.resolve(result(remote)) };
    }
  }
  Object.defineProperty(Deno, "Command", {
    value: MockCommand,
    configurable: true,
    writable: true,
  });
  try {
    return { result: await fn(), calls };
  } finally {
    Object.defineProperty(Deno, "Command", {
      value: Original,
      configurable: true,
      writable: true,
    });
  }
}

Deno.test("drawImage: writes the datapack, runs it, verifies, and records the drawing", async () => {
  await withPng([207, 213, 214, 255], async (imagePath) => {
    const { ctx, getWrittenResources } = setup();
    let ran = false;
    const { calls } = await withSpawnableSsh((remote) => {
      if (remote.includes("tmux has-session")) return { stdout: "exists\n" };
      if (remote.includes("level-name")) return { stdout: "world\n" };
      if (remote.startsWith("wc -l")) return { stdout: "100\n" };
      if (remote.includes("function swampdraw:logo_art")) ran = true;
      if (remote.startsWith("tail -n")) {
        return {
          stdout: ran
            ? "Running function swampdraw:logo_art\nTest passed\nTest passed\nTest passed\n"
            : "",
        };
      }
      return { stdout: "" };
    }, () =>
      model.methods.drawImage.execute(
        { ...DRAW_ARGS, imagePath },
        ctx,
      ));

    const writes = calls.filter((c) => c.stdin !== undefined);
    assertEquals(writes.length, 2);
    assertStringIncludes(
      writes[0].remote,
      `P="$HOME"/'mons/world/datapacks/swampdraw/pack.mcmeta'`,
    );
    assertEquals(JSON.parse(writes[0].stdin!).pack.pack_format, 48);
    assertStringIncludes(
      writes[1].remote,
      "data/swampdraw/function/logo_art.mcfunction",
    );
    assertEquals(
      writes[1].stdin,
      "fill -2 65 -10 1 65 -10 minecraft:white_concrete\n" +
        "fill -2 64 -10 1 64 -10 minecraft:white_concrete\n",
    );

    const r = getWrittenResources()[0];
    assertEquals(r.specName, "drawing");
    assertEquals(r.name, "drawing-logo_art");
    assertEquals(r.data.success, true);
    assertEquals(r.data.verified, 3);
    assertEquals(r.data.blocks, 8);
    assertEquals(r.data.function, "swampdraw:logo_art");
  });
});
