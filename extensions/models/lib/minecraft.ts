// Minecraft-specific helpers: argument validation, console I/O over
// ssh + tmux, and parsers for server console output. Pure functions are
// exported for unit tests.
import {
  assertSshTarget,
  isValidSshHost,
  shellQuote,
  sshExec,
  sshExecRaw,
} from "./ssh.ts";

// A remote path we interpolate into shell commands unquoted (so `~` still
// expands). No whitespace, quotes, globs or shell metacharacters; no leading "-".
const SAFE_PATH_RE = /^[A-Za-z0-9_~/.+@%=,:][A-Za-z0-9_~/.+@%=,:-]*$/;
// tmux session names: tmux itself rewrites "." and ":" so we disallow them.
const SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// Resource instance / metrics label names.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
// Java edition player names.
const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
// Namespaced dimension id, e.g. minecraft:overworld.
const DIMENSION_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** Throw unless `value` is a remote path that is safe to use unquoted. */
export function assertSafePath(label: string, value: string): void {
  if (!SAFE_PATH_RE.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": use letters, digits and ~/._-+@%=,: only (no spaces or shell metacharacters)`,
    );
  }
}

/** Throw unless `value` is a valid tmux session name. */
export function assertSessionName(value: string): void {
  if (!SESSION_RE.test(value)) {
    throw new Error(
      `Invalid tmuxSession "${value}": use letters, digits, _ and - only`,
    );
  }
}

/** Throw unless `value` is a safe resource/label name. */
export function assertName(label: string, value: string): void {
  if (!NAME_RE.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": use letters, digits, _ . and - only`,
    );
  }
}

/** Validate and return a Java edition player name. */
export function validatePlayerName(name: string): string {
  if (!PLAYER_RE.test(name)) {
    throw new Error(
      `Invalid playerName "${name}": expected 1-16 letters, digits or _`,
    );
  }
  return name;
}

/** Validate and return a namespaced dimension id. */
export function validateDimension(dimension: string): string {
  if (!DIMENSION_RE.test(dimension)) {
    throw new Error(
      `Invalid dimension "${dimension}": expected a namespaced id like minecraft:overworld`,
    );
  }
  return dimension;
}

/** Strip control characters (newlines would submit partial console input). */
export function sanitizeConsoleText(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** Global arguments shared by every `@keeb/minecraft/server` method. */
export interface ServerTarget {
  sshHost: string | null;
  sshUser: string;
  tmuxSession: string;
  serverDir: string;
  startScript: string;
  logPath: string;
  serverName: string;
}

/** Return every validation error for a server model's global arguments. */
export function serverTargetErrors(t: ServerTarget): string[] {
  const errors: string[] = [];
  const check = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      errors.push((e as Error).message);
    }
  };
  check(() => assertSessionName(t.tmuxSession));
  check(() => assertSafePath("serverDir", t.serverDir));
  check(() => assertSafePath("startScript", t.startScript));
  check(() => assertSafePath("logPath", t.logPath));
  check(() => assertName("serverName", t.serverName));
  // A missing host is allowed (methods skip cleanly); a present one must be valid.
  check(() =>
    assertSshTarget(
      isValidSshHost(t.sshHost) ? t.sshHost : "localhost",
      t.sshUser,
    )
  );
  return errors;
}

/** Throw a combined error when the server global arguments are invalid. */
export function assertServerTarget(t: ServerTarget): void {
  const errors = serverTargetErrors(t);
  if (errors.length) throw new Error(errors.join("; "));
}

/** Remote command that sends each line to the tmux console, then Enter. */
export function buildSendKeysCommand(
  tmuxSession: string,
  lines: string[],
): string {
  assertSessionName(tmuxSession);
  return lines.map((line) =>
    `tmux send-keys -t ${tmuxSession} -l ${
      shellQuote(sanitizeConsoleText(line))
    } && tmux send-keys -t ${tmuxSession} Enter`
  ).join(" && ");
}

/** Send console lines to the server; throws when the ssh/tmux call fails. */
export async function sendConsole(
  host: string,
  user: string,
  tmuxSession: string,
  lines: string[],
): Promise<void> {
  await sshExec(host, user, buildSendKeysCommand(tmuxSession, lines));
}

/** True when the tmux session exists on the host. */
export async function tmuxSessionExists(
  host: string,
  user: string,
  tmuxSession: string,
): Promise<boolean> {
  assertSessionName(tmuxSession);
  const r = await sshExecRaw(
    host,
    user,
    `tmux has-session -t ${tmuxSession} 2>/dev/null && echo exists || echo missing`,
  );
  return r.stdout.trim() === "exists";
}

/** Current line count of the server log (0 when missing). */
export async function logLineCount(
  host: string,
  user: string,
  logPath: string,
): Promise<number> {
  assertSafePath("logPath", logPath);
  const wc = await sshExecRaw(host, user, `wc -l < ${logPath}`);
  return parseInt(wc.stdout.trim(), 10) || 0;
}

/** Log lines written after line `afterLine`. */
export async function readLogFrom(
  host: string,
  user: string,
  logPath: string,
  afterLine: number,
): Promise<string> {
  assertSafePath("logPath", logPath);
  const r = await sshExecRaw(
    host,
    user,
    `tail -n +${Math.max(1, Math.floor(afterLine) + 1)} ${logPath}`,
  );
  return r.stdout;
}

/** Send console commands and return the log lines they produced. */
export async function consoleRun(
  host: string,
  user: string,
  tmuxSession: string,
  logPath: string,
  commands: string[],
  waitMs = 2000,
): Promise<string> {
  const from = await logLineCount(host, user, logPath);
  await sendConsole(host, user, tmuxSession, commands);
  await new Promise((r) => setTimeout(r, waitMs));
  return await readLogFrom(host, user, logPath, from);
}

/** Parsed `list` command response. */
export interface PlayerList {
  online: number;
  max: number;
  players: string[];
}

/** Parse the `There are N of a max of M players online: a, b` console line. */
export function parsePlayerList(log: string): PlayerList | null {
  const match = log.match(
    /There are (\d+) of a max of (\d+) players online:(.*)/,
  );
  if (!match) return null;
  const playerStr = match[3].trim();
  return {
    online: parseInt(match[1], 10),
    max: parseInt(match[2], 10),
    players: playerStr
      ? playerStr.split(",").map((p) => p.trim()).filter(Boolean)
      : [],
  };
}

/** Parsed `data get entity <player> Pos/Rotation/Dimension` responses. */
export interface PlayerPose {
  pos: number[];
  yaw: number;
  dimension: string | null;
}

/** Parse a player's position, yaw and dimension from console output. */
export function parsePlayerPose(log: string): PlayerPose | null {
  const pos = log.match(
    /entity data: \[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/,
  );
  const rot = log.match(/entity data: \[(-?[\d.E-]+)f, (-?[\d.E-]+)f\]/);
  const dim = log.match(/entity data: "([^"]+)"/);
  if (!pos || !rot) return null;
  const coords = [pos[1], pos[2], pos[3]].map(Number);
  const yaw = Number(rot[1]);
  if (coords.some((n) => !Number.isFinite(n)) || !Number.isFinite(yaw)) {
    return null;
  }
  return { pos: coords, yaw, dimension: dim ? dim[1] : null };
}

/** Datapack format from a server jar's version.json contents. */
export function parsePackFormat(versionJson: string): number {
  const pv = JSON.parse(versionJson)?.pack_version;
  const n = typeof pv === "number" ? pv : (pv?.data_major ?? pv?.data);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new Error("version.json has no usable pack_version");
  }
  return n;
}

/** pack.mcmeta contents for a datapack of the given format. */
export function buildMcmeta(packFormat: number): Record<string, unknown> {
  return packFormat >= 82
    ? {
      pack: {
        description: "swampdraw",
        min_format: packFormat,
        max_format: packFormat,
      },
    }
    : { pack: { description: "swampdraw", pack_format: packFormat } };
}

/** Function directory name: 1.21+ (format 45+) uses `function`. */
export function functionDir(packFormat: number): string {
  return packFormat >= 45 ? "function" : "functions";
}

/** Values discovered from a server pack's variables.txt. */
export interface PackVariables {
  modloader: string;
  mcVersion: string;
  modloaderVersion: string;
}

/** Parse MODLOADER / MINECRAFT_VERSION / MODLOADER_VERSION from variables.txt. */
export function parseVariables(text: string): PackVariables {
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}=(\\S+)`, "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : "";
  };
  return {
    modloader: get("MODLOADER"),
    mcVersion: get("MINECRAFT_VERSION"),
    modloaderVersion: get("MODLOADER_VERSION"),
  };
}
