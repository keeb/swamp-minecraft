// Shared helpers for game server metrics collection.
// Formats Prometheus textfile metrics and JSON log lines, writes via SSH.

import { shellQuote, sshExec } from "./ssh.ts";

/** Player data written to the textfile collector and the JSON log. */
export interface PlayerData {
  serverRunning: boolean;
  online: number;
  max: number | null;
  players: string[];
}

/** Escape a Prometheus label value (backslash, double quote, newline). */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(
    /\n/g,
    "\\n",
  );
}

/** Render Prometheus textfile-collector metrics for one server. */
export function formatPromMetrics(
  gameType: string,
  serverName: string,
  data: PlayerData,
  now: number = Date.now(),
): string {
  const labels = `game="${escapeLabel(gameType)}",server="${
    escapeLabel(serverName)
  }"`;
  const running = data.serverRunning ? 1 : 0;
  const lines = [
    `# HELP game_server_running Whether the game server process is running`,
    `# TYPE game_server_running gauge`,
    `game_server_running{${labels}} ${running}`,
    `# HELP game_players_online Current number of players online`,
    `# TYPE game_players_online gauge`,
    `game_players_online{${labels}} ${data.online}`,
  ];
  if (data.max !== null) {
    lines.push(
      `# HELP game_players_max Maximum player slots`,
      `# TYPE game_players_max gauge`,
      `game_players_max{${labels}} ${data.max}`,
    );
  }
  lines.push(
    `# HELP game_metrics_collected_at Unix timestamp of last successful collection`,
    `# TYPE game_metrics_collected_at gauge`,
    `game_metrics_collected_at{${labels}} ${Math.floor(now / 1000)}`,
  );
  return lines.join("\n") + "\n";
}

/** Render one JSON log line (picked up by promtail). */
export function formatLogLine(
  gameType: string,
  serverName: string,
  data: PlayerData,
  now: Date = new Date(),
): string {
  return JSON.stringify({
    ts: now.toISOString(),
    game: gameType,
    server: serverName,
    running: data.serverRunning,
    online: data.online,
    max: data.max,
    players: data.players,
  });
}

/** Build the remote shell command that atomically writes both files. */
export function buildMetricsCommand(
  gameType: string,
  promContent: string,
  logLine: string,
): string {
  if (!/^[a-z0-9_]+$/.test(gameType)) {
    throw new Error(`Invalid gameType "${gameType}"`);
  }
  const promDir = "/var/lib/node_exporter/textfile_collector";
  const promFile = `${promDir}/game_${gameType}.prom`;
  const logFile = "/var/log/game-players.log";
  // Atomic write: tmp then mv (prevents partial reads by node-exporter).
  return `mkdir -p ${promDir} && printf '%s' ${
    shellQuote(promContent)
  } > ${promFile}.tmp && mv ${promFile}.tmp ${promFile} && printf '%s\\n' ${
    shellQuote(logLine)
  } >> ${logFile}`;
}

/** Write the Prometheus textfile and append the JSON log line over ssh. */
export async function writeMetricsFiles(
  sshHost: string,
  sshUser: string,
  gameType: string,
  serverName: string,
  data: PlayerData,
): Promise<void> {
  const promContent = formatPromMetrics(gameType, serverName, data);
  const logLine = formatLogLine(gameType, serverName, data);
  await sshExec(
    sshHost,
    sshUser,
    buildMetricsCommand(gameType, promContent, logLine),
  );
}
