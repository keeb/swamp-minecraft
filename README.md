# @keeb/minecraft

[Swamp](https://github.com/systeminit/swamp) extension for Minecraft server control, installation, and metrics collection.

## Models

### `@keeb/minecraft/server`

Control a Minecraft server running in a tmux session over SSH.

| Method | Description |
|--------|-------------|
| `warnShutdown` | Broadcast a 30-second shutdown warning, then wait 30s |
| `startMinecraftServer` | Start the server in a tmux session and wait for readiness |
| `stopMinecraftServer` | Gracefully stop the server and wait for java to exit |
| `status` | Query player count and server status |
| `say` | Send an in-game chat message |
| `op` | Grant operator privileges to a player |
| `deop` | Revoke operator privileges from a player |
| `drawImage` | Draw a PNG into the world as block art via a generated datapack |
| `collectMetrics` | Collect player count and write Prometheus textfile metrics |

### `@keeb/minecraft/installer`

Install a Minecraft server from a modpack zip (or FTB's server installer) on a remote Alpine host.

| Method | Description |
|--------|-------------|
| `installDeps` | Install Java and dependencies with `apk` |
| `upload` | Upload a server pack zip to the VM with rsync |
| `extract` | Extract the server pack and discover its start script |
| `installFtb` | Install an FTB modpack with FTB's server installer |
| `configure` | Set EULA, JVM memory, and server variables |

## Workflows

| Workflow | Description |
|----------|-------------|
| `start-minecraft` | Start a Minecraft VM + server |
| `stop-minecraft` | Stop a Minecraft server + VM |
| `reboot-minecraft` | Stop + start a Minecraft server |
| `status-minecraft` | Query Minecraft player count |
| `minecraft-install` | Install a Minecraft server pack on a VM |
| `minecraft-install-ftb` | Install an FTB modpack server on a VM |
| `collect-game-metrics` | Collect player metrics from all game servers |

## Dependencies

- [@keeb/proxmox](https://github.com/keeb/swamp-proxmox) — Fleet VM start/stop, auth
- [@keeb/prometheus](https://github.com/keeb/swamp-prometheus) — Metrics collection setup

## Install

```bash
swamp extension pull @keeb/minecraft
```

## Example

Warn players, then gracefully stop a running server before VM shutdown:

```yaml
models:
  - name: mc
    type: "@keeb/minecraft/server"
    globalArguments:
      sshHost: "192.0.2.50"
      sshUser: "root"
      tmuxSession: "mons"
      serverDir: "~/mons"
      startScript: "./startserver.sh"
      logPath: "~/mons/logs/latest.log"
      serverName: "mons"

jobs:
  - name: graceful-stop
    steps:
      - model: mc
        method: warnShutdown
      - model: mc
        method: stopMinecraftServer
      - model: mc
        method: status
```

## Subprocesses and security

Both models drive remote hosts by spawning local processes with `Deno.Command`:

- `ssh` (OpenSSH client) runs every remote command, and pipes generated
  datapack files to the server for `drawImage`.
- `rsync` (over the same ssh transport) uploads the server pack in
  `installer.upload`.

There is no swamp primitive for running commands on a remote host, so these
subprocesses are the core of what the extension does. Requirements: `ssh`
and `rsync` on the machine running swamp, and key-based (agent or
`~/.ssh`) access to the target as `sshUser`.

What is validated before anything is spawned:

- `sshHost` must be a hostname or IP and `sshUser` a POSIX user name; neither
  may start with `-`, and `--` ends option parsing before the destination,
  so neither can be read as an ssh option.
- Paths interpolated into remote shell commands (`serverDir`, `logPath`,
  `startScript`, `remotePath`) are restricted to letters, digits and
  `~/._-+@%=,:` (no spaces, quotes or shell metacharacters). `tmuxSession`
  is limited to letters, digits, `_` and `-`.
- Free text sent to the server console (`say` messages) is shell-quoted,
  stripped of control characters, and sent with `tmux send-keys -l`.
  Player names must be valid Java edition names (1-16 of `[A-Za-z0-9_]`).
- `jvmMemory`, `javaPackage`, FTB `packId`/`versionId`, and `dimension` are
  checked against strict patterns; `upload` refuses a `localPath` that starts
  with `-` or is not an existing file.

Both models also register a `policy` pre-flight check (`valid-server-target`,
`valid-ssh-target`) that reports invalid global arguments before a method runs.

Host keys are not verified (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null`), matching the ephemeral-VM workflow this
extension is built for. Only point it at hosts on a network you trust.

## License

MIT
