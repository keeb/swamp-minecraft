# @keeb/minecraft

[Swamp](https://github.com/systeminit/swamp) extension for Minecraft server control, installation, and metrics collection.

## Models

### `minecraft/server`

Control a Minecraft server running in a tmux session over SSH.

| Method | Description |
|--------|-------------|
| `warnShutdown` | Send in-game countdown warnings before shutdown |
| `startMinecraftServer` | Start the server in a tmux session and wait for readiness |
| `stopMinecraftServer` | Gracefully stop the server |
| `status` | Query player count and server status |
| `say` | Send an in-game chat message |
| `op` | Grant operator privileges to a player |
| `deop` | Revoke operator privileges from a player |
| `collectMetrics` | Collect player count and write Prometheus textfile metrics |

### `minecraft/installer`

Install a Minecraft server from a modpack zip on a remote host.

| Method | Description |
|--------|-------------|
| `installDeps` | Install Java and dependencies |
| `upload` | Upload server pack zip to the VM |
| `extract` | Extract and configure the server pack |
| `configure` | Set EULA, JVM flags, and server properties |

## Workflows

| Workflow | Description |
|----------|-------------|
| `start-minecraft` | Start a Minecraft VM + server |
| `stop-minecraft` | Stop a Minecraft server + VM |
| `reboot-minecraft` | Stop + start a Minecraft server |
| `status-minecraft` | Query Minecraft player count |
| `minecraft-install` | Install a Minecraft server pack on a VM |
| `collect-game-metrics` | Collect player metrics from all game servers |

## Dependencies

- [@keeb/proxmox](https://github.com/keeb/swamp-proxmox) — Fleet VM start/stop, auth
- [@keeb/prometheus](https://github.com/keeb/swamp-prometheus) — Metrics collection setup

## Install

```bash
swamp extension pull @keeb/minecraft
```

## License

MIT
