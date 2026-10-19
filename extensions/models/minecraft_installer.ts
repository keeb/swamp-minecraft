/**
 * @keeb/minecraft/installer model — install a Minecraft server from a
 * server-pack zip (or FTB's server installer) on a remote Alpine VM: install
 * deps (JRE, tmux), upload the pack, extract + discover the start script,
 * and configure EULA + JVM memory.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  assertSshTarget,
  isValidSshHost,
  RSYNC_SSH,
  sshExec,
  sshExecRaw,
  waitForSsh,
} from "./lib/ssh.ts";
import { assertSafePath, parseVariables } from "./lib/minecraft.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP (set via CEL from fleet)"),
  sshUser: z.string().default("root").describe("SSH user"),
});

/** Validated global arguments of `@keeb/minecraft/installer`. */
export type InstallerGlobalArgs = z.infer<typeof GlobalArgs>;

/** The subset of the swamp method context these methods use. */
export interface InstallerContext {
  globalArgs: InstallerGlobalArgs;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

const DepsSchema = z.object({
  packages: z.string(),
  javaVersion: z.string().optional(),
  timestamp: z.string(),
});

const UploadSchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
  timestamp: z.string(),
});

const ServerSchema = z.object({
  modloader: z.string().optional(),
  mcVersion: z.string().optional(),
  modloaderVersion: z.string().optional(),
  startScript: z.string(),
  serverDir: z.string(),
  logPath: z.string(),
  timestamp: z.string(),
});

const FtbInstallSchema = z.object({
  packId: z.string(),
  versionId: z.string(),
  serverDir: z.string(),
  installerUrl: z.string(),
  timestamp: z.string(),
});

const ConfigSchema = z.object({
  jvmMemory: z.string(),
  eulaAccepted: z.boolean(),
  timestamp: z.string(),
});

const InstallDepsArgs = z.object({
  vmName: z.string().describe("VM name (used as resource instance name)"),
  javaPackage: z.string().default("openjdk21-jre").describe(
    "Alpine JRE package (e.g. openjdk25-jre for MC 26.x packs)",
  ),
});
const UploadArgs = z.object({
  vmName: z.string().describe("VM name (used as resource instance name)"),
  localPath: z.string().describe("Local path to the server pack zip"),
});
const ExtractArgs = z.object({
  vmName: z.string().describe("VM name (used as resource instance name)"),
  remotePath: z.string().describe("Remote path to the server pack zip"),
  serverDir: z.string().default("~/game").describe(
    "Directory to extract into",
  ),
});
const InstallFtbArgs = z.object({
  vmName: z.string().describe("VM name (used as resource instance name)"),
  packId: z.string().default("").describe("FTB modpack ID (required)"),
  versionId: z.string().default("").describe(
    "FTB version ID (empty = latest release)",
  ),
  serverDir: z.string().default("~/game").describe(
    "Directory to install into",
  ),
});
const ConfigureArgs = z.object({
  vmName: z.string().describe("VM name (used as resource instance name)"),
  serverDir: z.string().describe("Server directory"),
  jvmMemory: z.string().default("10G").describe("JVM memory (e.g. 10G)"),
});

const APK_PACKAGE_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const FTB_ID_RE = /^\d+$/;
const JVM_MEMORY_RE = /^\d+[KkMmGg]?$/;

/** Throw unless sshHost is present and user@host is a safe ssh destination. */
function requireTarget(g: InstallerGlobalArgs): string {
  if (!isValidSshHost(g.sshHost)) {
    throw new Error("sshHost is required - is the VM running?");
  }
  assertSshTarget(g.sshHost, g.sshUser);
  return g.sshHost;
}

/** Validate an Alpine package name. */
export function validateApkPackage(name: string): string {
  if (!APK_PACKAGE_RE.test(name)) {
    throw new Error(`Invalid javaPackage "${name}"`);
  }
  return name;
}

/** Validate a JVM heap size such as 10G or 8192M. */
export function validateJvmMemory(value: string): string {
  if (!JVM_MEMORY_RE.test(value)) {
    throw new Error(
      `Invalid jvmMemory "${value}": expected a size like 10G or 8192M`,
    );
  }
  return value;
}

/** FTB server-installer download URL for a pack (and optional version). */
export function ftbInstallerUrl(packId: string, versionId: string): string {
  if (!FTB_ID_RE.test(packId)) {
    throw new Error(`Invalid packId "${packId}": expected a numeric FTB id`);
  }
  if (versionId && !FTB_ID_RE.test(versionId)) {
    throw new Error(
      `Invalid versionId "${versionId}": expected a numeric FTB id`,
    );
  }
  return versionId
    ? `https://api.feed-the-beast.com/v1/modpacks/public/modpack/${packId}/${versionId}/server/linux`
    : `https://api.feed-the-beast.com/v1/modpacks/public/modpack/${packId}/server/linux`;
}

/** Build the rsync argv for uploading `localPath` to user@host:remotePath. */
export function buildRsyncArgs(
  host: string,
  user: string,
  localPath: string,
  remotePath: string,
): string[] {
  assertSshTarget(host, user);
  if (!localPath || localPath.startsWith("-")) {
    throw new Error(`Invalid localPath "${localPath}"`);
  }
  assertSafePath("remotePath", remotePath);
  return [
    "-az",
    "-e",
    RSYNC_SSH,
    "--",
    localPath,
    `${user}@${host}:${remotePath}`,
  ];
}

/** Swamp model definition for `@keeb/minecraft/installer`. */
export const model = {
  type: "@keeb/minecraft/installer",
  version: "2026.10.15.2",
  upgrades: [
    {
      toVersion: "2026.10.15.2",
      description: "No schema changes; arguments are now validated before use",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "ftbInstall": {
      description: "FTB server installer result (pack/version installed)",
      schema: FtbInstallSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "deps": {
      description: "Package install result",
      schema: DepsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "upload": {
      description: "Server pack upload result",
      schema: UploadSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "server": {
      description: "Discovered server config (modloader, start script, paths)",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "config": {
      description: "Server configuration result (JVM, EULA)",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  globalArguments: GlobalArgs,
  checks: {
    "valid-ssh-target": {
      description: "sshHost and sshUser are present and well-formed",
      labels: ["policy"],
      execute: (context: { globalArgs: InstallerGlobalArgs }) => {
        try {
          requireTarget(context.globalArgs);
          return Promise.resolve({ pass: true });
        } catch (e) {
          return Promise.resolve({
            pass: false,
            errors: [(e as Error).message],
          });
        }
      },
    },
  },
  methods: {
    installDeps: {
      description:
        "Install required packages (JRE, tmux, bash, curl, unzip) on the VM",
      arguments: InstallDepsArgs,
      execute: async (
        args: z.infer<typeof InstallDepsArgs>,
        context: InstallerContext,
      ) => {
        const { vmName } = args;
        const javaPackage = validateApkPackage(args.javaPackage);
        const { sshUser } = context.globalArgs;
        const sshHost = requireTarget(context.globalArgs);

        context.logger.info("Waiting for SSH on {host}", { host: sshHost });
        if (!(await waitForSsh(sshHost, sshUser))) {
          throw new Error(`SSH not reachable on ${sshHost} after 60s`);
        }

        const packages = `${javaPackage} tmux bash curl unzip`;
        context.logger.info("Installing packages: {packages}", { packages });
        await sshExec(sshHost, sshUser, `apk add ${packages}`);

        const javaResult = await sshExecRaw(
          sshHost,
          sshUser,
          "java -version 2>&1 | head -1",
        );
        const javaVersion = javaResult.stdout.trim();
        context.logger.info("Java version: {javaVersion}", { javaVersion });

        const handle = await context.writeResource("deps", vmName, {
          packages,
          javaVersion,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upload: {
      description: "Upload a server pack zip to the VM via rsync",
      arguments: UploadArgs,
      execute: async (
        args: z.infer<typeof UploadArgs>,
        context: InstallerContext,
      ) => {
        const { vmName, localPath } = args;
        const { sshUser } = context.globalArgs;
        const sshHost = requireTarget(context.globalArgs);
        const remotePath = "~/server-pack.zip";
        const rsyncArgs = buildRsyncArgs(
          sshHost,
          sshUser,
          localPath,
          remotePath,
        );

        let isFile = false;
        try {
          isFile = (await Deno.stat(localPath)).isFile;
        } catch {
          isFile = false;
        }
        if (!isFile) {
          throw new Error(`Server pack not found: ${localPath}`);
        }

        context.logger.info("Uploading {localPath} to {dest}", {
          localPath,
          dest: `${sshUser}@${sshHost}:${remotePath}`,
        });
        // swamp-quality-ignore deno-command: rsync uploads the server pack; host, user and paths are validated in buildRsyncArgs
        const result = await new Deno.Command("rsync", { args: rsyncArgs })
          .output();
        if (result.code !== 0) {
          const err = new TextDecoder().decode(result.stderr);
          throw new Error(
            `rsync to ${sshHost} failed (exit ${result.code}): ${err}`,
          );
        }
        context.logger.info("Upload complete", {});

        const handle = await context.writeResource("upload", vmName, {
          localPath,
          remotePath,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    extract: {
      description:
        "Extract server pack zip, discover modloader config and start script",
      arguments: ExtractArgs,
      execute: async (
        args: z.infer<typeof ExtractArgs>,
        context: InstallerContext,
      ) => {
        const { vmName, remotePath, serverDir } = args;
        const { sshUser } = context.globalArgs;
        const sshHost = requireTarget(context.globalArgs);
        assertSafePath("remotePath", remotePath);
        assertSafePath("serverDir", serverDir);

        context.logger.info("Extracting {remotePath} to {serverDir}", {
          remotePath,
          serverDir,
        });
        await sshExec(
          sshHost,
          sshUser,
          `mkdir -p ${serverDir} && cd ${serverDir} && unzip -o ${remotePath}`,
        );

        const varsResult = await sshExecRaw(
          sshHost,
          sshUser,
          `cat ${serverDir}/variables.txt 2>/dev/null || true`,
        );
        const { modloader, mcVersion, modloaderVersion } = parseVariables(
          varsResult.stdout,
        );
        if (modloader || mcVersion || modloaderVersion) {
          context.logger.info(
            "Discovered modloader={modloader} mc={mcVersion} modloaderVersion={modloaderVersion}",
            { modloader, mcVersion, modloaderVersion },
          );
        }

        // Discover start script
        const findResult = await sshExecRaw(
          sshHost,
          sshUser,
          `cd ${serverDir} && ls -1 startserver.sh start.sh run.sh ServerStart.sh Start.sh 2>/dev/null | head -1`,
        );
        let startScript = findResult.stdout.trim();
        if (!startScript) {
          const fallback = await sshExecRaw(
            sshHost,
            sshUser,
            `cd ${serverDir} && ls -1 *.sh 2>/dev/null | head -1`,
          );
          startScript = fallback.stdout.trim() || "startserver.sh";
        }
        context.logger.info("Start script: {startScript}", { startScript });

        const handle = await context.writeResource("server", vmName, {
          modloader,
          mcVersion,
          modloaderVersion,
          startScript: `./${startScript}`,
          serverDir,
          logPath: `${serverDir}/logs/latest.log`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    installFtb: {
      description:
        "Install an FTB modpack server via FTB's server installer (for packs that don't publish a server zip), using system Java",
      arguments: InstallFtbArgs,
      execute: async (
        args: z.infer<typeof InstallFtbArgs>,
        context: InstallerContext,
      ) => {
        const { vmName, packId, versionId, serverDir } = args;
        const { sshUser } = context.globalArgs;
        const sshHost = requireTarget(context.globalArgs);
        if (!packId) throw new Error("packId is required");
        assertSafePath("serverDir", serverDir);
        // The installer binary is pack-agnostic; the version-pinned URL just
        // bakes defaults into its filename. -pack/-version are authoritative.
        const installerUrl = ftbInstallerUrl(packId, versionId);
        const installerDir = "~/ftb-installer";

        context.logger.info("Downloading FTB installer from {url}", {
          url: installerUrl,
        });
        await sshExec(
          sshHost,
          sshUser,
          `mkdir -p ${installerDir} ${serverDir} && wget -q -O ${installerDir}/serverinstall '${installerUrl}' && chmod +x ${installerDir}/serverinstall`,
        );

        const flags = [
          `-pack ${packId}`,
          versionId ? `-version ${versionId}` : "",
          `-dir ${serverDir}`,
          "-auto",
          "-force",
          "-no-java",
          "-accept-eula",
          "-no-colours",
        ].filter(Boolean).join(" ");
        context.logger.info("Running installer: serverinstall {flags}", {
          flags,
        });
        const result = await sshExec(
          sshHost,
          sshUser,
          `set -o pipefail; cd ${installerDir} && ./serverinstall ${flags} 2>&1 | tail -20`,
        );
        context.logger.info("Installer output: {output}", {
          output: result.stdout,
        });

        const handle = await context.writeResource("ftbInstall", vmName, {
          packId,
          versionId: versionId || "latest",
          serverDir,
          installerUrl,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description: "Configure JVM memory, EULA, and server variables",
      arguments: ConfigureArgs,
      execute: async (
        args: z.infer<typeof ConfigureArgs>,
        context: InstallerContext,
      ) => {
        const { vmName, serverDir } = args;
        const jvmMemory = validateJvmMemory(args.jvmMemory);
        const { sshUser } = context.globalArgs;
        const sshHost = requireTarget(context.globalArgs);
        assertSafePath("serverDir", serverDir);

        context.logger.info("Configuring server in {serverDir}", { serverDir });

        // Update variables.txt if present (ServerPackCreator layout)
        const hasVars = await sshExecRaw(
          sshHost,
          sshUser,
          `test -f ${serverDir}/variables.txt && echo yes || echo no`,
        );
        if (hasVars.stdout.trim() === "yes") {
          context.logger.info(
            "Setting variables.txt JVM memory to {jvmMemory}",
            { jvmMemory },
          );
          await sshExec(
            sshHost,
            sshUser,
            `cd ${serverDir} && sed -i -e 's/JAVA_ARGS=.*/JAVA_ARGS="-Xmx${jvmMemory} -Xms${jvmMemory}"/' -e 's/SKIP_JAVA_CHECK=.*/SKIP_JAVA_CHECK=true/' -e 's/WAIT_FOR_USER_INPUT=.*/WAIT_FOR_USER_INPUT=false/' -e 's/RESTART=.*/RESTART=false/' variables.txt`,
          );
        }

        // NeoForge/Forge installer layout (run.sh + user_jvm_args.txt)
        const hasJvmArgs = await sshExecRaw(
          sshHost,
          sshUser,
          `test -f ${serverDir}/user_jvm_args.txt && echo yes || echo no`,
        );
        if (hasJvmArgs.stdout.trim() === "yes") {
          context.logger.info(
            "Setting user_jvm_args.txt JVM memory to {jvmMemory}",
            { jvmMemory },
          );
          await sshExec(
            sshHost,
            sshUser,
            `cd ${serverDir} && sed -i '/^-Xm[sx]/d' user_jvm_args.txt && printf '\\n-Xmx${jvmMemory}\\n-Xms${jvmMemory}\\n' >> user_jvm_args.txt`,
          );
        }

        context.logger.info("Accepting EULA", {});
        await sshExec(
          sshHost,
          sshUser,
          `echo "eula=true" > ${serverDir}/eula.txt`,
        );

        await sshExec(
          sshHost,
          sshUser,
          `chmod +x ${serverDir}/*.sh 2>/dev/null || true; mkdir -p ${serverDir}/logs`,
        );
        context.logger.info("Start scripts marked executable", {});

        const handle = await context.writeResource("config", vmName, {
          jvmMemory,
          eulaAccepted: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
