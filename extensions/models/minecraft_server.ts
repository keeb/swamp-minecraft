/**
 * @keeb/minecraft/server model — control a Minecraft server running in a
 * tmux session over SSH: start, stop, status, broadcast chat, op/deop
 * players, draw block art, and collect player metrics for the Prometheus
 * textfile collector.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  isValidSshHost,
  sshExecRaw,
  sshWriteFile,
  waitForSsh,
} from "./lib/ssh.ts";
import { writeMetricsFiles } from "./lib/metrics.ts";
import {
  assertServerTarget,
  buildMcmeta,
  consoleRun,
  functionDir,
  logLineCount,
  parsePackFormat,
  parsePlayerList,
  parsePlayerPose,
  type PlayerList,
  readLogFrom,
  sanitizeConsoleText,
  sendConsole,
  serverTargetErrors,
  tmuxSessionExists,
  validateDimension,
  validatePlayerName,
} from "./lib/minecraft.ts";
import {
  type Facing,
  gridToCommands,
  imageToBlockGrid,
  yawToFacing,
} from "./lib/pixelart.ts";

const GlobalArgs = z.object({
  sshHost: z.string().nullable().describe(
    "SSH hostname/IP (set via CEL from lookup model)",
  ),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  tmuxSession: z.string().default("mons").describe("tmux session name"),
  serverDir: z.string().default("~/mons").describe("Server directory path"),
  startScript: z.string().default("./startserver.sh").describe(
    "Start script relative to serverDir",
  ),
  logPath: z.string().default("~/mons/logs/latest.log").describe(
    "Path to latest.log",
  ),
  serverName: z.string().default("server").describe(
    "Resource instance name for writeResource",
  ),
});

/** Validated global arguments of `@keeb/minecraft/server`. */
export type ServerGlobalArgs = z.infer<typeof GlobalArgs>;

/** The subset of the swamp logger these methods use. */
export interface Logger {
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
}

/** The subset of the swamp method context these methods use. */
export interface ServerContext {
  globalArgs: ServerGlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

const ServerSchema = z.object({
  success: z.boolean().optional(),
  skipped: z.boolean().optional(),
  alreadyStopped: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  ip: z.string().optional(),
  serverRunning: z.boolean().optional(),
  serverReady: z.boolean().optional(),
  online: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  players: z.array(z.string()).optional(),
  timestamp: z.string().optional(),
});

const DrawingSchema = z.object({
  success: z.boolean(),
  imagePath: z.string(),
  function: z.string(),
  dimension: z.string(),
  anchor: z.array(z.number()),
  facing: z.string(),
  orientation: z.string(),
  width: z.number(),
  height: z.number(),
  blocks: z.number(),
  commands: z.number(),
  corners: z.array(z.array(z.number())),
  palette: z.string().describe("JSON map of block id -> count"),
  verified: z.number().describe("Spot-checked fills found in the world (of 3)"),
  timestamp: z.string(),
});

const SayArgs = z.object({
  message: z.string().default("").describe("Message to broadcast"),
});
const OpArgs = z.object({
  playerName: z.string().default("").describe("Player name to op"),
});
const DeopArgs = z.object({
  playerName: z.string().default("").describe("Player name to deop"),
});
const DrawImageArgs = z.object({
  imagePath: z.string().default("").describe(
    "Local path to a PNG (transparent pixels are skipped)",
  ),
  width: z.number().default(64).describe(
    "Width in blocks; height keeps the image aspect ratio",
  ),
  anchorPlayer: z.string().default("").describe(
    "Anchor on this online player's current position/facing (overrides x/y/z/facing/dimension)",
  ),
  x: z.number().nullable().default(null).describe("Anchor x"),
  y: z.number().nullable().default(null).describe("Anchor y"),
  z: z.number().nullable().default(null).describe("Anchor z"),
  facing: z.enum(["", "north", "south", "east", "west"]).default("")
    .describe("Direction the viewer at the anchor looks"),
  dimension: z.string().default("minecraft:overworld").describe(
    "Dimension id",
  ),
  orientation: z.enum(["wall", "floor"]).default("wall").describe(
    "Upright wall in front of the anchor, or flat on the ground",
  ),
  distance: z.number().default(10).describe(
    "Blocks between the anchor and the art",
  ),
  alphaThreshold: z.number().default(128)
    .describe("Average alpha below this leaves the block untouched"),
  name: z.string().default("draw").describe(
    "Function name: swampdraw:<name> (re-runnable later)",
  ),
  packFormat: z.number().default(0).describe(
    "Datapack format; 0 = detect from the server jar's version.json",
  ),
});
const NoArgs = z.object({});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared preamble: validate config, then report whether the console is reachable. */
async function consoleAvailable(
  context: ServerContext,
  method: string,
): Promise<boolean> {
  const g = context.globalArgs;
  if (!isValidSshHost(g.sshHost)) {
    context.logger.info("{method}: no sshHost, skipping", { method });
    return false;
  }
  assertServerTarget(g);
  if (!(await tmuxSessionExists(g.sshHost, g.sshUser, g.tmuxSession))) {
    context.logger.info("{method}: no tmux session {session}, skipping", {
      method,
      session: g.tmuxSession,
    });
    return false;
  }
  return true;
}

async function writeServer(
  context: ServerContext,
  data: Record<string, unknown>,
): Promise<{ dataHandles: unknown[] }> {
  const handle = await context.writeResource(
    "server",
    context.globalArgs.serverName,
    data,
  );
  return { dataHandles: [handle] };
}

/** Send `list` and parse the response; null when the reply wasn't seen. */
async function queryPlayers(g: ServerGlobalArgs): Promise<PlayerList | null> {
  const host = g.sshHost as string;
  const from = await logLineCount(host, g.sshUser, g.logPath);
  await sendConsole(host, g.sshUser, g.tmuxSession, ["list"]);
  await sleep(2000);
  return parsePlayerList(await readLogFrom(host, g.sshUser, g.logPath, from));
}

/** Swamp model definition for `@keeb/minecraft/server`. */
export const model = {
  type: "@keeb/minecraft/server",
  version: "2026.10.15.2",
  upgrades: [
    {
      toVersion: "2026.10.15.2",
      description:
        "No schema changes; global arguments are now validated before use",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "server": {
      description: "Minecraft server operation result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "metrics": {
      description: "Minecraft player metrics collection result",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "drawing": {
      description: "Block-art image drawn into the world by drawImage",
      schema: DrawingSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  checks: {
    "valid-server-target": {
      description:
        "Global arguments (tmux session, paths, user, serverName) are safe to use in remote shell commands",
      labels: ["policy"],
      execute: (context: { globalArgs: ServerGlobalArgs }) => {
        const errors = serverTargetErrors(context.globalArgs);
        return Promise.resolve(
          errors.length ? { pass: false, errors } : { pass: true },
        );
      },
    },
  },
  methods: {
    say: {
      description:
        "Broadcast a message to Minecraft players via the server console",
      arguments: SayArgs,
      execute: async (
        args: z.infer<typeof SayArgs>,
        context: ServerContext,
      ) => {
        const message = sanitizeConsoleText(args.message);
        if (!message) throw new Error("message is required");
        if (!(await consoleAvailable(context, "say"))) {
          return await writeServer(context, { success: true, skipped: true });
        }
        const g = context.globalArgs;
        context.logger.info("Broadcasting {message}", { message });
        await sendConsole(g.sshHost as string, g.sshUser, g.tmuxSession, [
          `say ${message}`,
        ]);
        return await writeServer(context, { success: true, skipped: false });
      },
    },

    op: {
      description: "Grant operator status to a Minecraft player",
      arguments: OpArgs,
      execute: async (
        args: z.infer<typeof OpArgs>,
        context: ServerContext,
      ) => {
        if (!args.playerName) throw new Error("playerName is required");
        const player = validatePlayerName(args.playerName);
        if (!(await consoleAvailable(context, "op"))) {
          return await writeServer(context, { success: true, skipped: true });
        }
        const g = context.globalArgs;
        context.logger.info("Granting op to {player}", { player });
        await sendConsole(g.sshHost as string, g.sshUser, g.tmuxSession, [
          `op ${player}`,
        ]);
        return await writeServer(context, { success: true, skipped: false });
      },
    },

    deop: {
      description: "Revoke operator status from a Minecraft player",
      arguments: DeopArgs,
      execute: async (
        args: z.infer<typeof DeopArgs>,
        context: ServerContext,
      ) => {
        if (!args.playerName) throw new Error("playerName is required");
        const player = validatePlayerName(args.playerName);
        if (!(await consoleAvailable(context, "deop"))) {
          return await writeServer(context, { success: true, skipped: true });
        }
        const g = context.globalArgs;
        context.logger.info("Revoking op from {player}", { player });
        await sendConsole(g.sshHost as string, g.sshUser, g.tmuxSession, [
          `deop ${player}`,
        ]);
        return await writeServer(context, { success: true, skipped: false });
      },
    },

    drawImage: {
      description:
        "Draw a PNG into the world as block art (concrete/wool/terracotta) via a generated datapack function, anchored on a player or fixed coordinates",
      arguments: DrawImageArgs,
      execute: async (
        args: z.infer<typeof DrawImageArgs>,
        context: ServerContext,
      ) => {
        if (!args.imagePath) throw new Error("imagePath is required");
        const width = Math.round(args.width);
        const distance = Math.round(args.distance);
        if (!(width >= 1 && width <= 512)) {
          throw new Error("width must be 1-512");
        }
        if (!(distance >= 1)) throw new Error("distance must be >= 1");
        const alphaThreshold = Math.min(255, Math.max(1, args.alphaThreshold));
        const fnName = args.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        if (!fnName) throw new Error("name is required");
        // Pure argument checks first, so bad input fails before any I/O.
        const anchorPlayer = args.anchorPlayer
          ? validatePlayerName(args.anchorPlayer)
          : "";
        if (!anchorPlayer) {
          if (args.x === null || args.y === null || args.z === null) {
            throw new Error("Provide anchorPlayer or all of x, y, z");
          }
          if (!args.facing) throw new Error("facing is required with x/y/z");
          validateDimension(args.dimension);
        }
        const g = context.globalArgs;
        const { sshUser, tmuxSession, serverDir, logPath } = g;
        if (!isValidSshHost(g.sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }
        const sshHost = g.sshHost;
        assertServerTarget(g);

        // Image -> block grid (local; fails before touching the server)
        const png = await Deno.readFile(args.imagePath);
        const { height, grid } = await imageToBlockGrid(
          png,
          width,
          alphaThreshold,
        );
        if (!grid.some((row) => row.some((b) => b !== null))) {
          throw new Error(
            `${args.imagePath} has no pixels above alphaThreshold ${alphaThreshold}; nothing to draw`,
          );
        }

        if (!(await tmuxSessionExists(sshHost, sshUser, tmuxSession))) {
          throw new Error(
            `No tmux session ${tmuxSession} on ${sshHost} - server not running`,
          );
        }

        // Resolve the anchor
        let anchor: number[];
        let facing: Facing;
        let dimension = args.dimension;
        if (anchorPlayer) {
          const out = await consoleRun(
            sshHost,
            sshUser,
            tmuxSession,
            logPath,
            [
              `data get entity ${anchorPlayer} Pos`,
              `data get entity ${anchorPlayer} Rotation`,
              `data get entity ${anchorPlayer} Dimension`,
            ],
          );
          const pose = parsePlayerPose(out);
          if (!pose) {
            throw new Error(
              `Could not read position of ${anchorPlayer} (offline?). Log:\n${out}`,
            );
          }
          anchor = pose.pos;
          facing = yawToFacing(pose.yaw);
          if (pose.dimension) dimension = pose.dimension;
          validateDimension(dimension);
        } else {
          anchor = [args.x as number, args.y as number, args.z as number];
          facing = args.facing as Facing;
        }
        context.logger.info(
          "Anchor {anchor} in {dimension}, facing {facing}",
          { anchor: anchor.join(", "), dimension, facing },
        );

        const { commands, counts, blocks, corners } = gridToCommands(
          grid,
          anchor,
          facing,
          args.orientation,
          distance,
        );
        context.logger.info(
          "{width}x{height} image -> {blocks} blocks in {commands} fill commands",
          { width, height, blocks, commands: commands.length },
        );
        const minY = Math.min(corners[0][1], corners[1][1]);
        const maxY = Math.max(corners[0][1], corners[1][1]);
        if (minY < -64 || maxY > 319) {
          throw new Error(
            `Art spans y ${minY}..${maxY}, outside build limits (-64..319)`,
          );
        }

        // Datapack format
        let packFormat = args.packFormat;
        if (!packFormat) {
          const ver = await sshExecRaw(
            sshHost,
            sshUser,
            `cd ${serverDir} && J=$(ls libraries/net/minecraft/server/*/server-*.jar 2>/dev/null | tail -1); unzip -p "\${J:-server.jar}" version.json`,
          );
          try {
            packFormat = parsePackFormat(ver.stdout);
          } catch (e) {
            throw new Error(
              `Could not detect pack format (pass packFormat): ${
                (e as Error).message
              } ${ver.stderr}`,
            );
          }
        }
        const mcmeta = buildMcmeta(packFormat);
        const fnDir = functionDir(packFormat);

        const levelName = (await sshExecRaw(
          sshHost,
          sshUser,
          `grep '^level-name=' ${serverDir}/server.properties | cut -d= -f2-`,
        )).stdout.trim() || "world";
        if (levelName.includes("/") || levelName.startsWith(".")) {
          throw new Error(`Refusing unexpected level-name "${levelName}"`);
        }
        const packDir = `${serverDir}/${levelName}/datapacks/swampdraw`;
        context.logger.info(
          "Writing datapack (format {packFormat}) to {packDir}",
          { packFormat, packDir },
        );
        await sshWriteFile(
          sshHost,
          sshUser,
          `${packDir}/pack.mcmeta`,
          JSON.stringify(mcmeta, null, 2) + "\n",
        );
        await sshWriteFile(
          sshHost,
          sshUser,
          `${packDir}/data/swampdraw/${fnDir}/${fnName}.mcfunction`,
          commands.join("\n") + "\n",
        );

        // Reload then run the function. Console commands queue behind the
        // reload (can take minutes on big modpacks), so send once and poll.
        const run = `execute in ${dimension} run function swampdraw:${fnName}`;
        const runAndWait = async () => {
          const from = await logLineCount(sshHost, sshUser, logPath);
          await sendConsole(sshHost, sshUser, tmuxSession, ["reload", run]);
          const deadline = Date.now() + 300000;
          while (Date.now() < deadline) {
            await sleep(5000);
            const out = await readLogFrom(sshHost, sshUser, logPath, from);
            if (/Unknown function/i.test(out)) return "unknown";
            if (
              new RegExp(
                `(Running|Executed).*function '?swampdraw:${fnName}\\b`,
              )
                .test(out)
            ) {
              return "ran";
            }
          }
          return "timeout";
        };
        context.logger.info("Reloading datapacks and running {run}", { run });
        let result = await runAndWait();
        if (result === "unknown") {
          context.logger.info("Function unknown, enabling pack", {});
          await consoleRun(sshHost, sshUser, tmuxSession, logPath, [
            'datapack enable "file/swampdraw"',
          ]);
          result = await runAndWait();
        }
        if (result !== "ran") {
          throw new Error(
            `Function swampdraw:${fnName} did not run (${result})`,
          );
        }

        // Spot-check the first, middle and last fill landed
        const picks = [
          commands[0],
          commands[Math.floor(commands.length / 2)],
          commands[commands.length - 1],
        ];
        const checkOut = await consoleRun(
          sshHost,
          sshUser,
          tmuxSession,
          logPath,
          picks.map((c) => {
            const [, x, y, z, , , , block] = c.split(" ");
            return `execute in ${dimension} if block ${x} ${y} ${z} ${block}`;
          }),
          3000,
        );
        const verified = (checkOut.match(/Test passed/g) || []).length;
        context.logger.info(
          "Spot-check {verified}/{total} passed; corners {corners}",
          {
            verified,
            total: picks.length,
            corners: JSON.stringify(corners),
          },
        );

        // Own instance name per drawing: instance names share one namespace
        // across specs, so reusing serverName would interleave drawings with
        // the server status history.
        const handle = await context.writeResource(
          "drawing",
          `drawing-${fnName}`,
          {
            success: verified === picks.length,
            imagePath: args.imagePath,
            function: `swampdraw:${fnName}`,
            dimension,
            anchor,
            facing,
            orientation: args.orientation,
            width,
            height,
            blocks,
            commands: commands.length,
            corners,
            palette: JSON.stringify(counts),
            verified,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    warnShutdown: {
      description:
        "Broadcast a shutdown warning to Minecraft players and wait 30 seconds",
      arguments: NoArgs,
      execute: async (
        _args: Record<string, never>,
        context: ServerContext,
      ) => {
        if (!(await consoleAvailable(context, "warnShutdown"))) {
          return await writeServer(context, { success: true, skipped: true });
        }
        const g = context.globalArgs;
        context.logger.info("Broadcasting shutdown warning", {});
        const warning = "say == SERVER SHUTTING DOWN IN 30 SECONDS ==";
        await sendConsole(g.sshHost as string, g.sshUser, g.tmuxSession, [
          warning,
          warning,
          warning,
        ]);
        context.logger.info("Waiting 30s before shutdown", {});
        await sleep(30000);
        context.logger.info("Shutdown warning complete", {});
        return await writeServer(context, { success: true, skipped: false });
      },
    },

    stopMinecraftServer: {
      description:
        "Gracefully stop a Minecraft server running in a tmux session via SSH, then wait for java to exit",
      arguments: NoArgs,
      execute: async (
        _args: Record<string, never>,
        context: ServerContext,
      ) => {
        const g = context.globalArgs;
        const alreadyStopped = () =>
          writeServer(context, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: new Date().toISOString(),
          });

        if (!isValidSshHost(g.sshHost)) {
          context.logger.info("No sshHost - VM may be stopped already", {});
          return await alreadyStopped();
        }
        const sshHost = g.sshHost;
        const { sshUser, tmuxSession } = g;
        assertServerTarget(g);

        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          context.logger.info(
            "SSH unreachable at {host} - VM may be stopped already",
            { host: sshHost },
          );
          return await alreadyStopped();
        }

        const tmuxExists = await tmuxSessionExists(
          sshHost,
          sshUser,
          tmuxSession,
        );
        // "[j]ava" so pgrep doesn't match the remote shell running this line.
        const javaCheck = await sshExecRaw(
          sshHost,
          sshUser,
          "pgrep -f '[j]ava' > /dev/null 2>&1 && echo running || echo stopped",
        );
        const javaRunning = javaCheck.stdout.trim() === "running";

        if (!tmuxExists && !javaRunning) {
          context.logger.info(
            "No tmux session and no java process - server already stopped",
            {},
          );
          return await alreadyStopped();
        }

        if (tmuxExists) {
          context.logger.info("Sending stop to tmux session {session}", {
            session: tmuxSession,
          });
          await sendConsole(sshHost, sshUser, tmuxSession, ["stop"]);
        }

        let timedOut = false;
        const javaPid = await sshExecRaw(
          sshHost,
          sshUser,
          "pgrep -f '[j]ava.*neoforge' || pgrep -f '[j]ava'",
        );
        const originalPid = javaPid.stdout.trim().split("\n")[0];
        if (/^\d+$/.test(originalPid)) {
          context.logger.info(
            "Tracking java PID {pid}, waiting for exit (up to 90s)",
            { pid: originalPid },
          );
          const pollStart = Date.now();
          const pollDeadline = pollStart + 90_000;
          timedOut = true;
          while (Date.now() < pollDeadline) {
            await sleep(3000);
            const check = await sshExecRaw(
              sshHost,
              sshUser,
              `kill -0 ${originalPid} 2>/dev/null && echo running || echo stopped`,
            );
            if (check.stdout.trim() === "stopped") {
              timedOut = false;
              context.logger.info("Java PID {pid} exited after {elapsed}s", {
                pid: originalPid,
                elapsed: Math.round((Date.now() - pollStart) / 1000),
              });
              break;
            }
          }
          if (timedOut) {
            context.logger.warning("Timed out waiting for java to exit", {});
          }
        } else {
          context.logger.info("No java process found after stop", {});
        }

        // Kill tmux session to prevent the restart loop from respawning
        context.logger.info("Killing tmux session to prevent restart loop", {});
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`,
        );

        context.logger.info("Stop complete (timedOut={timedOut})", {
          timedOut,
        });
        return await writeServer(context, {
          success: true,
          alreadyStopped: false,
          timedOut,
          ip: sshHost,
          timestamp: new Date().toISOString(),
        });
      },
    },

    status: {
      description: "Query Minecraft server status: player count and names",
      arguments: NoArgs,
      execute: async (
        _args: Record<string, never>,
        context: ServerContext,
      ) => {
        const g = context.globalArgs;
        const notRunning = () =>
          writeServer(context, {
            serverRunning: false,
            timestamp: new Date().toISOString(),
          });

        if (!isValidSshHost(g.sshHost)) {
          context.logger.info("No sshHost - VM may be stopped", {});
          return await notRunning();
        }
        assertServerTarget(g);
        const reachable = await sshExecRaw(g.sshHost, g.sshUser, "echo ok");
        if (reachable.code !== 0) {
          context.logger.info("SSH unreachable at {host} - VM may be stopped", {
            host: g.sshHost,
          });
          return await notRunning();
        }
        if (!(await tmuxSessionExists(g.sshHost, g.sshUser, g.tmuxSession))) {
          context.logger.info("No tmux session - server not running", {});
          return await notRunning();
        }

        context.logger.info("Sending list command", {});
        const list = await queryPlayers(g);
        if (list) {
          context.logger.info("{online}/{max} players online: {players}", {
            online: list.online,
            max: list.max,
            players: list.players.join(", ") || "(none)",
          });
          return await writeServer(context, {
            serverRunning: true,
            online: list.online,
            max: list.max,
            players: list.players,
            timestamp: new Date().toISOString(),
          });
        }

        context.logger.warning("Could not parse player list from log", {});
        return await writeServer(context, {
          serverRunning: true,
          online: null,
          max: null,
          players: [],
          timestamp: new Date().toISOString(),
        });
      },
    },

    startMinecraftServer: {
      description:
        "Start a Minecraft server in a tmux session via SSH on a running VM",
      arguments: NoArgs,
      execute: async (
        _args: Record<string, never>,
        context: ServerContext,
      ) => {
        const g = context.globalArgs;
        if (!isValidSshHost(g.sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }
        const sshHost = g.sshHost;
        const { sshUser, tmuxSession, serverDir, startScript, logPath } = g;
        assertServerTarget(g);

        context.logger.info("Waiting for SSH on {host}", { host: sshHost });
        if (!(await waitForSsh(sshHost, sshUser))) {
          throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        }

        const startLog = `/tmp/mc-start-${tmuxSession}.log`;

        context.logger.info("Cleaning up stale tmux session", {});
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`,
        );

        // Truncate old logs so we only detect the new "Done" line
        await sshExecRaw(
          sshHost,
          sshUser,
          `truncate -s 0 ${logPath} 2>/dev/null || true; truncate -s 0 ${startLog} 2>/dev/null || true`,
        );

        context.logger.info(
          "Starting server in tmux session {session}, output to {startLog}",
          { session: tmuxSession, startLog },
        );
        const startResult = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux new-session -d -s ${tmuxSession} -c ${serverDir} 'bash ${startScript} 2>&1 | tee ${startLog}'`,
        );
        if (startResult.code !== 0) {
          throw new Error(
            `Failed to start tmux session ${tmuxSession} on ${sshHost}: ${startResult.stderr}`,
          );
        }

        // Poll logs for "Done"; fail fast if the tmux session dies.
        const readyTimeout = 900; // 15 minutes (NeoForge install + modded boot)
        const readyPoll = 5; // seconds
        const readyStart = Date.now();
        const readyDeadline = readyStart + (readyTimeout * 1000);
        context.logger.info("Waiting up to {timeout}s for server to be ready", {
          timeout: readyTimeout,
        });

        let serverReady = false;
        while (Date.now() < readyDeadline) {
          const logCheck = await sshExecRaw(
            sshHost,
            sshUser,
            `grep -q '\\]: Done (' ${logPath} 2>/dev/null && echo READY || echo WAITING`,
          );
          if (logCheck.stdout.trim() === "READY") {
            context.logger.info("Server is ready after {elapsed}s", {
              elapsed: Math.round((Date.now() - readyStart) / 1000),
            });
            serverReady = true;
            break;
          }

          if (!(await tmuxSessionExists(sshHost, sshUser, tmuxSession))) {
            const startOutput = await sshExecRaw(
              sshHost,
              sshUser,
              `cat ${startLog} 2>/dev/null || echo "(no output)"`,
            );
            throw new Error(
              `Server process exited before becoming ready. start script output:\n${startOutput.stdout}`,
            );
          }

          context.logger.info(
            "Server not ready yet ({elapsed}s elapsed), polling in {poll}s",
            {
              elapsed: Math.round((Date.now() - readyStart) / 1000),
              poll: readyPoll,
            },
          );
          await sleep(readyPoll * 1000);
        }

        if (!serverReady) {
          const startOutput = await sshExecRaw(
            sshHost,
            sshUser,
            `cat ${startLog} 2>/dev/null || echo "(no output)"`,
          );
          throw new Error(
            `Minecraft server did not become ready within ${readyTimeout}s. start script output:\n${startOutput.stdout}`,
          );
        }

        return await writeServer(context, {
          success: true,
          ip: sshHost,
          serverReady: true,
          timestamp: new Date().toISOString(),
        });
      },
    },

    collectMetrics: {
      description:
        "Collect player metrics and write Prometheus textfile + JSON log",
      arguments: NoArgs,
      execute: async (
        _args: Record<string, never>,
        context: ServerContext,
      ) => {
        const g = context.globalArgs;
        const { serverName } = g;
        const writeMetrics = async (data: Record<string, unknown>) => {
          const handle = await context.writeResource("metrics", serverName, {
            ...data,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        };
        const offline = {
          serverRunning: false,
          online: 0,
          max: null,
          players: [] as string[],
        };

        if (!isValidSshHost(g.sshHost)) {
          context.logger.info("No sshHost - VM may be stopped", {});
          return await writeMetrics(offline);
        }
        const sshHost = g.sshHost;
        assertServerTarget(g);

        const reachable = await sshExecRaw(sshHost, g.sshUser, "echo ok");
        if (reachable.code !== 0) {
          context.logger.info("SSH unreachable at {host}", { host: sshHost });
          return await writeMetrics(offline);
        }

        if (!(await tmuxSessionExists(sshHost, g.sshUser, g.tmuxSession))) {
          context.logger.info("No tmux session - server not running", {});
          await writeMetricsFiles(
            sshHost,
            g.sshUser,
            "minecraft",
            serverName,
            offline,
          );
          return await writeMetrics(offline);
        }

        const list = await queryPlayers(g);
        if (!list) {
          context.logger.warning(
            "Could not parse player list; reporting 0 online",
            {},
          );
        }
        const data = {
          serverRunning: true,
          online: list?.online ?? 0,
          max: list?.max ?? null,
          players: list?.players ?? [],
        };
        context.logger.info("{online}/{max} players: {players}", {
          online: data.online,
          max: data.max ?? "?",
          players: data.players.join(", ") || "(none)",
        });

        await writeMetricsFiles(
          sshHost,
          g.sshUser,
          "minecraft",
          serverName,
          data,
        );
        return await writeMetrics(data);
      },
    },
  },
};
