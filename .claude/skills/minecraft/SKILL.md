---
name: minecraft
description: Control Minecraft servers via swamp — start, stop, reboot, query status, broadcast chat, op/deop players, install modpacks from server-pack zips, and collect player metrics for Prometheus. Provides the `@user/minecraft/server` and `@user/minecraft/installer` model types from the `@keeb/minecraft` extension. Use when the user mentions Minecraft, modded Minecraft (NeoForge/Forge/Fabric), tmux-managed game servers over SSH, server packs, EULA setup, JVM memory tuning for game servers, in-game broadcasts (`say`), op/deop, player counts, or game metrics for Prometheus textfile collector. Triggers on phrases like "start minecraft", "stop the mc server", "reboot minecraft", "minecraft player count", "install a modpack", "broadcast to minecraft", "op a player", "minecraft metrics".
---

# minecraft

The `@keeb/minecraft` extension controls Minecraft servers running in tmux
sessions over SSH, installs server packs (NeoForge / Forge / Fabric / vanilla),
and collects player metrics. It depends on `@keeb/proxmox` for VM lifecycle and
`@keeb/prometheus` for metrics ingestion.

## Models

### `@user/minecraft/server`

Operate a running (or expected-to-be-running) Minecraft server over SSH+tmux.

Global arguments:

- `sshHost` (nullable string) — usually wired via CEL from a fleet/lookup model
- `sshUser` (default `root`)
- `tmuxSession` (default `mons`)
- `serverDir` (default `~/mons`)
- `startScript` (default `./startserver.sh`, relative to `serverDir`)
- `logPath` (default `~/mons/logs/latest.log`)
- `serverName` (default `server`) — resource instance name written by every
  method

Resources written: `server` and `metrics` (both `ServerSchema`, `infinite`
lifetime, gc 10).

Methods:

| Method                 | Args                         | Notes                                                                                                                                                                                                          |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `say`                  | `message: string` (required) | Sends `say <msg>` via `tmux send-keys`. No-ops (skipped) when sshHost missing or tmux session absent.                                                                                                          |
| `op`                   | `playerName: string`         | Sanitizes to `[a-zA-Z0-9_]`. Same skip behavior as `say`.                                                                                                                                                      |
| `deop`                 | `playerName: string`         | Same as `op`.                                                                                                                                                                                                  |
| `warnShutdown`         | none                         | Broadcasts shutdown warning 3x and sleeps 30s. Skips cleanly if sshHost/tmux missing.                                                                                                                          |
| `startMinecraftServer` | none                         | Waits for SSH, kills stale tmux, truncates log, starts via `tmux new-session ... bash <startScript>`. Polls log for `]: Done (` for up to **15 minutes** (NeoForge boots are slow). Throws if tmux dies early. |
| `stopMinecraftServer`  | none                         | Sends `stop`, waits up to 90s for the java PID to exit, then `tmux kill-session` to defeat restart loops. Treats missing SSH/tmux/java as already-stopped (success).                                           |
| `status`               | none                         | Sends `list` to console, tails new log lines, parses `There are N of a max of M players online: ...`. Writes `serverRunning`, `online`, `max`, `players`.                                                      |
| `collectMetrics`       | none                         | Like `status` but also writes Prometheus textfile + JSON via `writeMetricsFiles` to the **resource named `metrics`** (not `server`). Returns zeros when SSH/tmux unreachable rather than failing.              |

### `@user/minecraft/installer`

Install a Minecraft server pack on a fresh VM.

Global arguments:

- `sshHost` (required) — wire via CEL from `fleet` lookup
- `sshUser` (default `root`)

Resources: `deps`, `upload`, `server` (discovered config), `config`. All
`infinite` lifetime, gc 5.

Methods (all take `vmName: string` as the resource instance key):

| Method        | Extra args                                           | Notes                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installDeps` | —                                                    | `apk add openjdk21-jre tmux bash curl unzip` — **Alpine only** (uses `apk`).                                                                                                                         |
| `upload`      | `localPath: string`                                  | rsyncs the local zip to `~/server-pack.zip` on the VM. Uses `StrictHostKeyChecking=no`.                                                                                                              |
| `extract`     | `remotePath: string`, `serverDir` (default `~/game`) | Unzips, parses `variables.txt` for `MODLOADER`/`MINECRAFT_VERSION`/`MODLOADER_VERSION`, finds a start script (`startserver.sh`, `start.sh`, `run.sh`, `ServerStart.sh`, `Start.sh`, then any `*.sh`). |
| `configure`   | `serverDir: string`, `jvmMemory` (default `10G`)     | Patches `variables.txt` JVM flags, sets `SKIP_JAVA_CHECK=true`, `WAIT_FOR_USER_INPUT=false`, `RESTART=false`, writes `eula.txt`, chmods `*.sh`, creates `logs/`.                                     |

## Workflows shipped with the extension

- `start-minecraft` — auth (proxmox) → fleet.start → startMinecraftServer →
  grafana annotation
- `stop-minecraft` — auth → fleet.lookup → warnShutdown → stopMinecraftServer →
  fleet.stop → grafana annotation
- `reboot-minecraft` — full stop chain followed by full start chain
- `status-minecraft` — auth → fleet.lookup → status
- `minecraft-install` — auth → fleet.lookup → (installDeps + upload) → extract →
  configure → startMinecraftServer → enable textfile collector
- `collect-game-metrics` — auth → fleet.sync → collectMetrics for each game
  server (Minecraft and Terraria)

## Common patterns

### Wiring sshHost via CEL

The server model takes `sshHost` as a nullable global arg so the methods can
gracefully no-op when a VM is stopped. Wire it from a `@keeb/proxmox` fleet
lookup resource using a CEL expression in the model definition YAML, e.g.:

```yaml
type: "@user/minecraft/server"
name: allthemonsMinecraft
globalArguments:
  sshHost: ${{ resources.fleet.allthemons.ip }}
  tmuxSession: mons
  serverDir: ~/mons
  startScript: ./startserver.sh
  logPath: ~/mons/logs/latest.log
  serverName: allthemons
```

### Per-server model instances

Each Minecraft server is its own model instance. Use distinct `serverName`
values so resources written by `writeResource` don't collide. Workflows then
target `modelIdOrName: <instanceName>` (e.g. `allthemonsMinecraft`,
`infinityMinecraft`).

### Workflow inputs

Every server-control workflow (`start/stop/reboot/status-minecraft`) requires
`vmName`, `tmuxSession`, `serverDir`, `startScript`, and `logPath`. Pass these
when running:

```bash
swamp workflow run start-minecraft \
  --input vmName=allthemons \
  --input tmuxSession=mons \
  --input serverDir=~/mons \
  --input startScript=./startserver.sh \
  --input logPath=~/mons/logs/latest.log
```

### Broadcasting / op without a workflow

Use `swamp model method` directly against a configured server instance:

```bash
swamp model method allthemonsMinecraft say --arg message="server reboot in 5"
swamp model method allthemonsMinecraft op  --arg playerName=keeb
```

## Gotchas

- **Alpine-only installer.** `installDeps` runs `apk add`. Don't aim
  `minecraft-install` at Debian/Ubuntu/RHEL VMs without rewriting that step.
- **15-minute start timeout.** `startMinecraftServer` polls for `]: Done (` for
  900 seconds. Modded packs (NeoForge install, mod loading) routinely take 5–10
  minutes the first time. Don't shorten this without good reason.
- **`collectMetrics` writes to a different resource than `status`.** It writes
  to `metrics`, not `server`. Query `metrics` when you want the time series of
  player counts.
- **Server resource is gc'd at 10 versions, metrics at 10, installer at 5.** Old
  data ages out — don't rely on long history.
- **Player name sanitization.** `op`/`deop` strip everything outside
  `[a-zA-Z0-9_]`. Bedrock-style names with spaces or punctuation will be
  mangled.
- **Restart-loop defeat.** `stopMinecraftServer` deliberately
  `tmux kill-session`s after the java PID exits — pack start scripts that
  auto-respawn would otherwise restart the server.
- **NeoForge PID tracking.** `stopMinecraftServer` first tries
  `pgrep -f 'java.*neoforge'` and falls back to `pgrep -f java`. Mixed-purpose
  hosts running other JVMs may confuse the wait loop.
- **`sshHost` is nullable on the server model but required on the installer
  model.** The server methods skip cleanly when null; the installer methods
  throw.
- **Dependencies.** `@keeb/proxmox` (fleet/auth) and `@keeb/prometheus`
  (textfile collector setup) must be installed for the bundled workflows to
  resolve.
