/**
 * @keeb/minecraft/server model — control a Minecraft server running in a
 * tmux session over SSH: start, stop, status, broadcast chat, op/deop
 * players, and collect player metrics for Prometheus textfile collector.
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
  gridToCommands,
  imageToBlockGrid,
  yawToFacing,
} from "./lib/pixelart.ts";

// Send console commands via tmux and return the log lines they produced.
async function consoleRun(
  sshHost,
  sshUser,
  tmuxSession,
  logPath,
  commands,
  waitMs = 2000,
) {
  const wc = await sshExecRaw(sshHost, sshUser, `wc -l < ${logPath}`);
  const lineCount = parseInt(wc.stdout.trim(), 10) || 0;
  for (const cmd of commands) {
    await sshExecRaw(
      sshHost,
      sshUser,
      `tmux send-keys -t ${tmuxSession} '${cmd}' Enter`,
    );
  }
  await new Promise((r) => setTimeout(r, waitMs));
  const tail = await sshExecRaw(
    sshHost,
    sshUser,
    `tail -n +${lineCount + 1} ${logPath}`,
  );
  return tail.stdout;
}

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

/** Swamp model definition for `@keeb/minecraft/server`. */
export const model: {
  type: string;
  version: string;
  resources: Record<string, unknown>;
  globalArguments: typeof GlobalArgs;
  methods: Record<string, unknown>;
} = {
  type: "@keeb/minecraft/server",
  version: "2026.02.18.2",
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
  methods: {
    say: {
      description:
        "Broadcast a message to Minecraft players via the server console",
      arguments: z.object({
        message: z.string().default("").describe("Message to broadcast"),
      }),
      execute: async (args, context) => {
        if (!args.message) throw new Error("message is required");
        const { message } = args;
        const { sshHost, sshUser = "root", tmuxSession, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[say] No sshHost - skipping`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[say] No tmux session - server not running`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        console.log(`[say] Broadcasting: ${message}`);
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux send-keys -t ${tmuxSession} 'say ${message}' Enter`,
        );

        const handle = await context.writeResource("server", serverName, {
          success: true,
          skipped: false,
        });
        return { dataHandles: [handle] };
      },
    },

    op: {
      description: "Grant operator status to a Minecraft player",
      arguments: z.object({
        playerName: z.string().default("").describe("Player name to op"),
      }),
      execute: async (args, context) => {
        if (!args.playerName) throw new Error("playerName is required");
        const sanitized = args.playerName.replace(/[^a-zA-Z0-9_]/g, "");
        const { sshHost, sshUser = "root", tmuxSession, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[op] No sshHost - skipping`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[op] No tmux session - server not running`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        console.log(`[op] Granting op to: ${sanitized}`);
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux send-keys -t ${tmuxSession} 'op ${sanitized}' Enter`,
        );

        const handle = await context.writeResource("server", serverName, {
          success: true,
          skipped: false,
        });
        return { dataHandles: [handle] };
      },
    },

    deop: {
      description: "Revoke operator status from a Minecraft player",
      arguments: z.object({
        playerName: z.string().default("").describe("Player name to deop"),
      }),
      execute: async (args, context) => {
        if (!args.playerName) throw new Error("playerName is required");
        const sanitized = args.playerName.replace(/[^a-zA-Z0-9_]/g, "");
        const { sshHost, sshUser = "root", tmuxSession, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[deop] No sshHost - skipping`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[deop] No tmux session - server not running`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        console.log(`[deop] Revoking op from: ${sanitized}`);
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux send-keys -t ${tmuxSession} 'deop ${sanitized}' Enter`,
        );

        const handle = await context.writeResource("server", serverName, {
          success: true,
          skipped: false,
        });
        return { dataHandles: [handle] };
      },
    },

    drawImage: {
      description:
        "Draw a PNG into the world as block art (concrete/wool/terracotta) via a generated datapack function, anchored on a player or fixed coordinates",
      arguments: z.object({
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
      }),
      execute: async (args, context) => {
        if (!args.imagePath) throw new Error("imagePath is required");
        const width = Math.round(args.width);
        const distance = Math.round(args.distance);
        if (width < 1 || width > 512) throw new Error("width must be 1-512");
        if (distance < 1) throw new Error("distance must be >= 1");
        const alphaThreshold = Math.min(255, Math.max(1, args.alphaThreshold));
        const fnName = args.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const {
          sshHost,
          sshUser = "root",
          tmuxSession,
          serverDir,
          logPath,
          serverName,
        } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }
        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          throw new Error("No tmux session - server not running");
        }

        // Resolve the anchor
        let anchor, facing = args.facing, dimension = args.dimension;
        if (args.anchorPlayer) {
          const player = args.anchorPlayer.replace(/[^a-zA-Z0-9_]/g, "");
          const out = await consoleRun(
            sshHost,
            sshUser,
            tmuxSession,
            logPath,
            [
              `data get entity ${player} Pos`,
              `data get entity ${player} Rotation`,
              `data get entity ${player} Dimension`,
            ],
          );
          const pos = out.match(
            /entity data: \[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/,
          );
          const rot = out.match(
            /entity data: \[(-?[\d.E-]+)f, (-?[\d.E-]+)f\]/,
          );
          const dim = out.match(/entity data: "([^"]+)"/);
          if (!pos || !rot) {
            throw new Error(
              `Could not read position of ${player} (offline?). Log:\n${out}`,
            );
          }
          anchor = [pos[1], pos[2], pos[3]].map(Number);
          facing = yawToFacing(Number(rot[1]));
          if (dim) dimension = dim[1];
        } else {
          if (args.x === null || args.y === null || args.z === null) {
            throw new Error("Provide anchorPlayer or all of x, y, z");
          }
          if (!facing) throw new Error("facing is required with x/y/z");
          anchor = [args.x, args.y, args.z];
        }
        console.log(
          `[drawImage] Anchor ${
            anchor.join(", ")
          } in ${dimension}, facing ${facing}`,
        );

        // Image -> blocks -> fill commands
        // @ts-ignore - Deno API
        const png = await Deno.readFile(args.imagePath);
        const { height, grid } = imageToBlockGrid(png, width, alphaThreshold);
        const { commands, counts, blocks, corners } = gridToCommands(
          grid,
          anchor,
          facing,
          args.orientation,
          distance,
        );
        console.log(
          `[drawImage] ${width}x${height} image -> ${blocks} blocks in ${commands.length} fill commands`,
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
            const pv = JSON.parse(ver.stdout).pack_version;
            packFormat = typeof pv === "number"
              ? pv
              : (pv.data_major ?? pv.data);
          } catch {
            throw new Error(
              `Could not detect pack format (pass packFormat): ${ver.stderr}`,
            );
          }
        }
        const mcmeta = packFormat >= 82
          ? {
            pack: {
              description: "swampdraw",
              min_format: packFormat,
              max_format: packFormat,
            },
          }
          : { pack: { description: "swampdraw", pack_format: packFormat } };
        // 1.21+ uses data/<ns>/function, older uses functions
        const fnDir = packFormat >= 45 ? "function" : "functions";

        const levelName = (await sshExecRaw(
          sshHost,
          sshUser,
          `grep '^level-name=' ${serverDir}/server.properties | cut -d= -f2`,
        )).stdout.trim() || "world";
        const packDir = `${serverDir}/${levelName}/datapacks/swampdraw`;
        console.log(
          `[drawImage] Writing datapack (format ${packFormat}) to ${packDir}`,
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
          const wc = await sshExecRaw(sshHost, sshUser, `wc -l < ${logPath}`);
          const from = (parseInt(wc.stdout.trim(), 10) || 0) + 1;
          await sshExecRaw(
            sshHost,
            sshUser,
            `tmux send-keys -t ${tmuxSession} 'reload' Enter && tmux send-keys -t ${tmuxSession} '${run}' Enter`,
          );
          const deadline = Date.now() + 300000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5000));
            const out = (await sshExecRaw(
              sshHost,
              sshUser,
              `tail -n +${from} ${logPath} | grep -E 'function swampdraw:${fnName}|Unknown function'`,
            )).stdout;
            if (/Unknown function/i.test(out)) return "unknown";
            if (/(Running|Executed).*function swampdraw:/.test(out)) {
              return "ran";
            }
          }
          return "timeout";
        };
        console.log(`[drawImage] Reloading datapacks and running ${run}...`);
        let result = await runAndWait();
        if (result === "unknown") {
          console.log(`[drawImage] Function unknown, enabling pack...`);
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
        console.log(
          `[drawImage] Spot-check ${verified}/${picks.length} passed; corners ${
            JSON.stringify(corners)
          }`,
        );

        const handle = await context.writeResource("drawing", serverName, {
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
        });
        return { dataHandles: [handle] };
      },
    },

    warnShutdown: {
      description:
        "Broadcast a shutdown warning to Minecraft players and wait 30 seconds",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[warnShutdown] No sshHost - skipping warning`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists
        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[warnShutdown] No tmux session - skipping warning`);
          const handle = await context.writeResource("server", serverName, {
            success: true,
            skipped: true,
          });
          return { dataHandles: [handle] };
        }

        // Broadcast warning 3 times
        console.log(`[warnShutdown] Broadcasting shutdown warning...`);
        for (let i = 0; i < 3; i++) {
          await sshExecRaw(
            sshHost,
            sshUser,
            `tmux send-keys -t ${tmuxSession} 'say == SERVER SHUTTING DOWN IN 30 SECONDS ==' Enter`,
          );
        }

        // Wait 30 seconds
        console.log(`[warnShutdown] Waiting 30s...`);
        await new Promise((r) => setTimeout(r, 30000));

        console.log(`[warnShutdown] Done`);
        const handle = await context.writeResource("server", serverName, {
          success: true,
          skipped: false,
        });
        return { dataHandles: [handle] };
      },
    },

    stopMinecraftServer: {
      description:
        "Gracefully stop a Minecraft server running in a tmux session via SSH, then wait for java to exit",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(
            `[stopMinecraftServer] No sshHost - VM may be stopped already`,
          );
          const handle = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Quick SSH reachability check
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(
            `[stopMinecraftServer] SSH unreachable at ${sshHost} - VM may be stopped already`,
          );
          const handle = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Check if tmux session exists and java is running
        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        const javaCheck = await sshExecRaw(
          sshHost,
          sshUser,
          "pgrep -f java > /dev/null 2>&1 && echo running || echo stopped",
        );

        const tmuxExists = tmuxCheck.stdout.trim() === "exists";
        const javaRunning = javaCheck.stdout.trim() === "running";

        if (!tmuxExists && !javaRunning) {
          console.log(
            `[stopMinecraftServer] No tmux session and no java process - server already stopped`,
          );
          const handle = await context.writeResource("server", serverName, {
            success: true,
            alreadyStopped: true,
            timedOut: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Send 'stop' command to MC console
        if (tmuxExists) {
          console.log(
            `[stopMinecraftServer] Sending 'stop' command to tmux session '${tmuxSession}'...`,
          );
          await sshExecRaw(
            sshHost,
            sshUser,
            `tmux send-keys -t ${tmuxSession} 'stop' Enter`,
          );
        }

        // Wait for java to exit
        const javaPid = await sshExecRaw(
          sshHost,
          sshUser,
          "pgrep -f 'java.*neoforge' || pgrep -f java",
        );
        const originalPid = javaPid.stdout.trim().split("\n")[0];
        console.log(
          `[stopMinecraftServer] Tracking java PID ${originalPid}, waiting for exit (up to 90s)...`,
        );

        const pollTimeout = 90;
        const pollStart = Date.now();
        const pollDeadline = pollStart + (pollTimeout * 1000);
        let timedOut = false;

        while (Date.now() < pollDeadline) {
          await new Promise((r) => setTimeout(r, 3000));
          const check = await sshExecRaw(
            sshHost,
            sshUser,
            `kill -0 ${originalPid} 2>/dev/null && echo running || echo stopped`,
          );
          if (check.stdout.trim() === "stopped") {
            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            console.log(
              `[stopMinecraftServer] Java PID ${originalPid} exited after ${elapsed}s`,
            );
            break;
          }
        }

        if (Date.now() >= pollDeadline) {
          timedOut = true;
          console.log(
            `[stopMinecraftServer] Timed out waiting for java to exit`,
          );
        }

        // Kill tmux session to prevent the restart loop from respawning
        console.log(
          `[stopMinecraftServer] Killing tmux session to prevent restart loop...`,
        );
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`,
        );

        console.log(`[stopMinecraftServer] Done (timedOut=${timedOut})`);
        const handle = await context.writeResource("server", serverName, {
          success: true,
          alreadyStopped: false,
          timedOut,
          ip: sshHost,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Query Minecraft server status: player count and names",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, logPath, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[status] No sshHost - VM may be stopped`);
          const handle = await context.writeResource("server", serverName, {
            serverRunning: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Quick SSH reachability check
        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(
            `[status] SSH unreachable at ${sshHost} - VM may be stopped`,
          );
          const handle = await context.writeResource("server", serverName, {
            serverRunning: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Check tmux session exists
        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[status] No tmux session - server not running`);
          const handle = await context.writeResource("server", serverName, {
            serverRunning: false,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Record current log line count
        const wcResult = await sshExecRaw(
          sshHost,
          sshUser,
          `wc -l < ${logPath}`,
        );
        const lineCount = parseInt(wcResult.stdout.trim(), 10) || 0;
        console.log(
          `[status] Log has ${lineCount} lines, sending 'list' command...`,
        );

        // Send 'list' command to MC console
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux send-keys -t ${tmuxSession} 'list' Enter`,
        );

        // Wait for server to process the command
        await new Promise((r) => setTimeout(r, 2000));

        // Read new log lines
        const tailResult = await sshExecRaw(
          sshHost,
          sshUser,
          `tail -n +${lineCount + 1} ${logPath}`,
        );
        const newLines = tailResult.stdout;

        // Parse for player list response
        const match = newLines.match(
          /There are (\d+) of a max of (\d+) players online:(.*)/,
        );
        if (match) {
          const online = parseInt(match[1], 10);
          const max = parseInt(match[2], 10);
          const playerStr = match[3].trim();
          const players = playerStr
            ? playerStr.split(",").map((p) => p.trim()).filter(Boolean)
            : [];
          console.log(
            `[status] ${online}/${max} players online: ${
              players.join(", ") || "(none)"
            }`,
          );
          const handle = await context.writeResource("server", serverName, {
            serverRunning: true,
            online,
            max,
            players,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        console.log(`[status] Could not parse player list from log`);
        const handle = await context.writeResource("server", serverName, {
          serverRunning: true,
          online: null,
          max: null,
          players: [],
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startMinecraftServer: {
      description:
        "Start a Minecraft server in a tmux session via SSH on a running VM",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const {
          sshHost,
          sshUser = "root",
          tmuxSession,
          serverDir,
          startScript,
          logPath,
          serverName,
        } = context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          throw new Error("sshHost is required - is the VM running?");
        }

        // Wait for SSH to be ready
        console.log(`[startMinecraftServer] Waiting for SSH on ${sshHost}...`);
        const sshReady = await waitForSsh(sshHost, sshUser);
        if (!sshReady) {
          throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        }

        const startLog = `/tmp/mc-start-${tmuxSession}.log`;

        // Kill stale tmux session (ignore errors)
        console.log(`[startMinecraftServer] Cleaning up stale tmux session...`);
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`,
        );

        // Truncate old log so we only detect the new "Done" line
        await sshExecRaw(
          sshHost,
          sshUser,
          `truncate -s 0 ${logPath} 2>/dev/null || true`,
        );
        await sshExecRaw(
          sshHost,
          sshUser,
          `truncate -s 0 ${startLog} 2>/dev/null || true`,
        );

        // Start new tmux session with start script, capturing output to startLog
        console.log(
          `[startMinecraftServer] Starting Minecraft server in tmux session '${tmuxSession}', output → ${startLog}...`,
        );
        const startResult = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux new-session -d -s ${tmuxSession} -c ${serverDir} 'bash ${startScript} 2>&1 | tee ${startLog}'`,
        );
        if (startResult.code !== 0) {
          throw new Error(
            `Failed to start tmux session: ${startResult.stderr}`,
          );
        }

        // Wait for server to be ready (poll logs for "Done" message)
        // Also detect early exit: if tmux session dies and log has an error, fail fast
        const readyTimeout = 900; // 15 minutes (NeoForge install + modded server boot)
        const readyPoll = 5; // seconds
        const readyStart = Date.now();
        const readyDeadline = readyStart + (readyTimeout * 1000);
        console.log(
          `[startMinecraftServer] Waiting up to ${readyTimeout}s for server to be ready...`,
        );

        let serverReady = false;
        while (Date.now() < readyDeadline) {
          const logCheck = await sshExecRaw(
            sshHost,
            sshUser,
            `grep -q '\\]: Done (' ${logPath} 2>/dev/null && echo READY || echo WAITING`,
          );
          if (logCheck.stdout.trim() === "READY") {
            const elapsed = Math.round((Date.now() - readyStart) / 1000);
            console.log(
              `[startMinecraftServer] Server is ready! (${elapsed}s)`,
            );
            serverReady = true;
            break;
          }

          // Check if tmux session already died (early crash)
          const tmuxAlive = await sshExecRaw(
            sshHost,
            sshUser,
            `tmux has-session -t ${tmuxSession} 2>/dev/null && echo alive || echo dead`,
          );
          if (tmuxAlive.stdout.trim() === "dead") {
            const startOutput = await sshExecRaw(
              sshHost,
              sshUser,
              `cat ${startLog} 2>/dev/null || echo "(no output)"`,
            );
            throw new Error(
              `Server process exited before becoming ready. start.sh output:\n${startOutput.stdout}`,
            );
          }

          const elapsed = Math.round((Date.now() - readyStart) / 1000);
          console.log(
            `[startMinecraftServer] Server not ready yet (${elapsed}s elapsed), polling in ${readyPoll}s...`,
          );
          await new Promise((r) => setTimeout(r, readyPoll * 1000));
        }

        if (!serverReady) {
          const startOutput = await sshExecRaw(
            sshHost,
            sshUser,
            `cat ${startLog} 2>/dev/null || echo "(no output)"`,
          );
          throw new Error(
            `Minecraft server did not become ready within ${readyTimeout}s. start.sh output:\n${startOutput.stdout}`,
          );
        }

        const handle = await context.writeResource("server", serverName, {
          success: true,
          ip: sshHost,
          serverReady: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    collectMetrics: {
      description:
        "Collect player metrics and write Prometheus textfile + JSON log",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", tmuxSession, logPath, serverName } =
          context.globalArgs;

        if (!isValidSshHost(sshHost)) {
          console.log(`[collectMetrics] No sshHost - VM may be stopped`);
          const handle = await context.writeResource("metrics", serverName, {
            serverRunning: false,
            online: 0,
            max: null,
            players: [],
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        const reachable = await sshExecRaw(sshHost, sshUser, "echo ok");
        if (reachable.code !== 0) {
          console.log(`[collectMetrics] SSH unreachable at ${sshHost}`);
          const handle = await context.writeResource("metrics", serverName, {
            serverRunning: false,
            online: 0,
            max: null,
            players: [],
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Check tmux session
        const tmuxCheck = await sshExecRaw(
          sshHost,
          sshUser,
          `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
        );
        if (tmuxCheck.stdout.trim() !== "exists") {
          console.log(`[collectMetrics] No tmux session - server not running`);
          const data = {
            serverRunning: false,
            online: 0,
            max: null,
            players: [],
          };
          await writeMetricsFiles(sshHost, sshUser, "minecraft", serverName, {
            ...data,
          });
          const handle = await context.writeResource("metrics", serverName, {
            ...data,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Query players (same logic as status)
        const wcResult = await sshExecRaw(
          sshHost,
          sshUser,
          `wc -l < ${logPath}`,
        );
        const lineCount = parseInt(wcResult.stdout.trim(), 10) || 0;
        await sshExecRaw(
          sshHost,
          sshUser,
          `tmux send-keys -t ${tmuxSession} 'list' Enter`,
        );
        await new Promise((r) => setTimeout(r, 2000));
        const tailResult = await sshExecRaw(
          sshHost,
          sshUser,
          `tail -n +${lineCount + 1} ${logPath}`,
        );

        const match = tailResult.stdout.match(
          /There are (\d+) of a max of (\d+) players online:(.*)/,
        );
        const online = match ? parseInt(match[1], 10) : 0;
        const max = match ? parseInt(match[2], 10) : null;
        const playerStr = match ? match[3].trim() : "";
        const players = playerStr
          ? playerStr.split(",").map((p) => p.trim()).filter(Boolean)
          : [];

        console.log(
          `[collectMetrics] ${online}/${max ?? "?"} players: ${
            players.join(", ") || "(none)"
          }`,
        );

        const data = { serverRunning: true, online, max, players };
        await writeMetricsFiles(
          sshHost,
          sshUser,
          "minecraft",
          serverName,
          data,
        );

        const handle = await context.writeResource("metrics", serverName, {
          ...data,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
