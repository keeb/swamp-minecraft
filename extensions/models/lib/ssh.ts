// SSH helpers shared across extension models.
//
// Every remote operation shells out to the local OpenSSH client (and rsync for
// uploads). Arguments are validated before they reach argv: the user and host
// must match strict patterns (so neither can be read as an ssh option), and a
// `--` ends option parsing before the destination. Remote command strings are
// built by the models from validated values; see lib/minecraft.ts.

/** Result of a remote command. */
export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
];

const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// Hostname, IPv4, or bare IPv6. Must not start with "-".
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

/** True when an sshHost value is present (not empty/null/"null"/"undefined"). */
export function isValidSshHost(host: unknown): host is string {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  return true;
}

/** Throw unless `user`@`host` is a safe ssh destination. */
export function assertSshTarget(host: string, user: string): void {
  if (!HOST_RE.test(host)) {
    throw new Error(
      `Invalid sshHost "${host}": expected a hostname or IP address`,
    );
  }
  if (!USER_RE.test(user)) {
    throw new Error(`Invalid sshUser "${user}": expected a POSIX user name`);
  }
}

/** Build the ssh argv for running `command` on user@host. Pure. */
export function buildSshArgs(
  host: string,
  user: string,
  command: string,
): string[] {
  assertSshTarget(host, user);
  return [...SSH_OPTS, "--", `${user}@${host}`, command];
}

/** The `-e` transport string rsync uses (same options as buildSshArgs). */
export const RSYNC_SSH = ["ssh", ...SSH_OPTS].join(" ");

/** Quote a string as one POSIX shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a remote path as one shell word, keeping a leading `~/` expandable
 * (`~/a b` becomes `"$HOME"/'a b'`).
 */
export function quoteRemotePath(path: string): string {
  if (path === "~") return `"$HOME"`;
  if (path.startsWith("~/")) return `"$HOME"/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

const decoder = new TextDecoder();

/** Run a command on the remote host; throws on a non-zero exit. */
export async function sshExec(
  host: string,
  user: string,
  command: string,
): Promise<SshResult> {
  const result = await sshExecRaw(host, user, command);
  if (result.code !== 0) {
    throw new Error(
      `SSH command failed on ${host} (exit ${result.code}): ${
        result.stderr.slice(-500)
      }`,
    );
  }
  return result;
}

/** Run a command on the remote host and return its exit code and output. */
export async function sshExecRaw(
  host: string,
  user: string,
  command: string,
): Promise<SshResult> {
  const args = buildSshArgs(host, user, command);
  // swamp-quality-ignore deno-command: ssh is the transport this extension wraps; user and host are validated in buildSshArgs
  const result = await new Deno.Command("ssh", { args }).output();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

/** Write `content` to `remotePath` (creating parent dirs) by piping it over ssh. */
export async function sshWriteFile(
  host: string,
  user: string,
  remotePath: string,
  content: string,
): Promise<void> {
  const p = quoteRemotePath(remotePath);
  const args = buildSshArgs(
    host,
    user,
    `P=${p}; mkdir -p "$(dirname "$P")" && cat > "$P"`,
  );
  // swamp-quality-ignore deno-command: ssh is the transport this extension wraps; user and host are validated in buildSshArgs
  const child = new Deno.Command("ssh", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  let writeError: unknown = null;
  try {
    await writer.write(new TextEncoder().encode(content));
  } catch (e) {
    writeError = e;
  } finally {
    await writer.close().catch(() => {});
  }
  // Always reap the child, even when the write failed (e.g. ssh exited early).
  const result = await child.output();
  if (result.code !== 0) {
    throw new Error(
      `Failed to write ${remotePath} on ${host} (exit ${result.code}): ${
        decoder.decode(result.stderr).slice(-500)
      }`,
    );
  }
  if (writeError) {
    throw new Error(
      `Failed to write ${remotePath} on ${host}: ${
        (writeError as Error).message
      }`,
    );
  }
}

/** Poll `echo ready` over ssh until it succeeds or `timeoutSeconds` pass. */
export async function waitForSsh(
  host: string,
  user: string,
  timeoutSeconds = 60,
  pollInterval = 3,
): Promise<boolean> {
  const deadline = Date.now() + (timeoutSeconds * 1000);

  while (Date.now() < deadline) {
    const result = await sshExecRaw(host, user, "echo ready");
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1000));
  }

  return false;
}
