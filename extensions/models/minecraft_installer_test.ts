/**
 * Unit tests for the `@keeb/minecraft/installer` model. ssh and rsync are
 * mocked with `withMockedCommand`.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import {
  buildRsyncArgs,
  ftbInstallerUrl,
  type InstallerContext,
  model,
  validateApkPackage,
  validateJvmMemory,
} from "./minecraft_installer.ts";

type Out = { stdout?: string; stderr?: string; code?: number };
type Route = [RegExp, Out];

function setup(globalArgs: { sshHost: string; sshUser?: string }) {
  const t = createModelTestContext({
    globalArgs: { sshUser: "root", ...globalArgs },
  });
  return { ...t, ctx: t.context as unknown as InstallerContext };
}

function withCommands<T>(routes: Route[], fn: () => Promise<T>) {
  return withMockedCommand((cmd, args) => {
    const line = `${cmd} ${args[args.length - 1]}`;
    for (const [re, out] of routes) {
      if (re.test(line)) {
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

const HOST = "198.51.100.7";

Deno.test("model is a plain catalogable object with a matching upgrade", () => {
  assertEquals(model.type, "@keeb/minecraft/installer");
  assertEquals(
    model.upgrades[model.upgrades.length - 1].toVersion,
    model.version,
  );
});

Deno.test("valid-ssh-target check", async () => {
  const check = model.checks["valid-ssh-target"];
  assertEquals(
    await check.execute({ globalArgs: { sshHost: HOST, sshUser: "root" } }),
    { pass: true },
  );
  const bad = await check.execute({
    globalArgs: { sshHost: "-oProxyCommand=x", sshUser: "root" },
  });
  assertEquals(bad.pass, false);
  const missing = await check.execute({
    globalArgs: { sshHost: "null", sshUser: "root" },
  });
  assertEquals(missing.pass, false);
});

Deno.test("argument validators", () => {
  assertEquals(validateApkPackage("openjdk25-jre"), "openjdk25-jre");
  assertThrows(() => validateApkPackage("jre; reboot"), Error);
  assertEquals(validateJvmMemory("10G"), "10G");
  assertEquals(validateJvmMemory("8192M"), "8192M");
  assertThrows(() => validateJvmMemory("10G/' x"), Error, "Invalid jvmMemory");
  assertEquals(
    ftbInstallerUrl("119", ""),
    "https://api.feed-the-beast.com/v1/modpacks/public/modpack/119/server/linux",
  );
  assertEquals(
    ftbInstallerUrl("119", "12345"),
    "https://api.feed-the-beast.com/v1/modpacks/public/modpack/119/12345/server/linux",
  );
  assertThrows(() => ftbInstallerUrl("119'", ""), Error, "Invalid packId");
  assertThrows(() => ftbInstallerUrl("119", "x"), Error, "Invalid versionId");
});

Deno.test("buildRsyncArgs ends options before paths and rejects option-like paths", () => {
  const args = buildRsyncArgs(HOST, "root", "/tmp/pack.zip", "~/pack.zip");
  assertEquals(args.slice(-3), [
    "--",
    "/tmp/pack.zip",
    `root@${HOST}:~/pack.zip`,
  ]);
  assertThrows(
    () => buildRsyncArgs(HOST, "root", "-e sh", "~/pack.zip"),
    Error,
    "Invalid localPath",
  );
  assertThrows(
    () => buildRsyncArgs(HOST, "root", "/tmp/p.zip", "~/a b.zip"),
    Error,
    "Invalid remotePath",
  );
});

Deno.test("installDeps: installs packages and records the java version", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  const { calls } = await withCommands([
    [/echo ready/, { stdout: "ready\n" }],
    [/java -version/, { stdout: 'openjdk version "21.0.4"\n' }],
  ], () =>
    model.methods.installDeps.execute(
      { vmName: "mc1", javaPackage: "openjdk21-jre" },
      ctx,
    ));
  assert(
    calls.some((c) =>
      c.args.at(-1) === "apk add openjdk21-jre tmux bash curl unzip"
    ),
  );
  const r = getWrittenResources()[0];
  assertEquals(r.specName, "deps");
  assertEquals(r.name, "mc1");
  assertEquals(r.data.javaVersion, 'openjdk version "21.0.4"');
});

Deno.test("installDeps: apk failure fails the method without writing", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  await withCommands([
    [/echo ready/, { stdout: "ready\n" }],
    [/apk add/, { code: 1, stderr: "ERROR: unable to select packages" }],
  ], async () => {
    await assertRejects(
      () =>
        model.methods.installDeps.execute(
          { vmName: "mc1", javaPackage: "openjdk21-jre" },
          ctx,
        ),
      Error,
      "unable to select packages",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("installDeps: missing sshHost is an error", async () => {
  const { ctx } = setup({ sshHost: "" });
  await assertRejects(
    () =>
      model.methods.installDeps.execute(
        { vmName: "mc1", javaPackage: "openjdk21-jre" },
        ctx,
      ),
    Error,
    "sshHost is required",
  );
});

Deno.test("upload: rsyncs an existing file", async () => {
  const dir = await Deno.makeTempDir();
  const zip = `${dir}/pack.zip`;
  await Deno.writeFile(zip, new Uint8Array([80, 75, 3, 4]));
  try {
    const { ctx, getWrittenResources } = setup({ sshHost: HOST });
    const { calls } = await withCommands(
      [],
      () =>
        model.methods.upload.execute({ vmName: "mc1", localPath: zip }, ctx),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].command, "rsync");
    assertEquals(calls[0].args.slice(-2), [
      zip,
      `root@${HOST}:~/server-pack.zip`,
    ]);
    assertEquals(getWrittenResources()[0].data.remotePath, "~/server-pack.zip");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upload: missing local file fails before rsync", async () => {
  const { ctx } = setup({ sshHost: HOST });
  const { calls } = await withCommands([], async () => {
    await assertRejects(
      () =>
        model.methods.upload.execute(
          { vmName: "mc1", localPath: "/nonexistent/pack.zip" },
          ctx,
        ),
      Error,
      "Server pack not found",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("upload: rsync failure is reported with its stderr", async () => {
  const dir = await Deno.makeTempDir();
  const zip = `${dir}/pack.zip`;
  await Deno.writeFile(zip, new Uint8Array([1]));
  try {
    const { ctx } = setup({ sshHost: HOST });
    await withCommands([[/^rsync/, {
      code: 12,
      stderr: "connection unexpectedly closed",
    }]], async () => {
      await assertRejects(
        () =>
          model.methods.upload.execute({ vmName: "mc1", localPath: zip }, ctx),
        Error,
        "connection unexpectedly closed",
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extract: parses variables.txt and finds the start script", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  await withCommands([
    [/variables\.txt/, {
      stdout:
        'MINECRAFT_VERSION=1.21.1\nMODLOADER=NeoForge\nMODLOADER_VERSION="21.1.77"\n',
    }],
    [/ls -1 startserver\.sh/, { stdout: "startserver.sh\n" }],
  ], () =>
    model.methods.extract.execute(
      { vmName: "mc1", remotePath: "~/server-pack.zip", serverDir: "~/game" },
      ctx,
    ));
  const data = getWrittenResources()[0].data;
  assertEquals(data.modloader, "NeoForge");
  assertEquals(data.mcVersion, "1.21.1");
  assertEquals(data.modloaderVersion, "21.1.77");
  assertEquals(data.startScript, "./startserver.sh");
  assertEquals(data.logPath, "~/game/logs/latest.log");
});

Deno.test("extract: falls back to any .sh, then startserver.sh", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  await withCommands([
    [/ls -1 \*\.sh/, { stdout: "launch.sh\n" }],
  ], () =>
    model.methods.extract.execute(
      { vmName: "mc1", remotePath: "~/server-pack.zip", serverDir: "~/game" },
      ctx,
    ));
  assertEquals(getWrittenResources()[0].data.startScript, "./launch.sh");
  assertEquals(getWrittenResources()[0].data.modloader, "");
});

Deno.test("extract: unzip failure and unsafe paths fail", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  await withCommands(
    [[/unzip/, { code: 9, stderr: "cannot find zipfile" }]],
    async () => {
      await assertRejects(
        () =>
          model.methods.extract.execute(
            { vmName: "mc1", remotePath: "~/missing.zip", serverDir: "~/game" },
            ctx,
          ),
        Error,
        "cannot find zipfile",
      );
      await assertRejects(
        () =>
          model.methods.extract.execute(
            { vmName: "mc1", remotePath: "~/p.zip", serverDir: "~/game;id" },
            ctx,
          ),
        Error,
        "Invalid serverDir",
      );
    },
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("installFtb: downloads into ~/ftb-installer and runs with flags", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST, sshUser: "mc" });
  const { calls } = await withCommands(
    [],
    () =>
      model.methods.installFtb.execute(
        { vmName: "mc1", packId: "119", versionId: "", serverDir: "~/game" },
        ctx,
      ),
  );
  const cmds = calls.map((c) => c.args.at(-1) ?? "");
  assertStringIncludes(cmds[0], "wget -q -O ~/ftb-installer/serverinstall");
  assertStringIncludes(cmds[1], "./serverinstall -pack 119 -dir ~/game -auto");
  assert(!cmds[1].includes("-version"));
  assertEquals(getWrittenResources()[0].data.versionId, "latest");
});

Deno.test("installFtb: packId is required and must be numeric", async () => {
  const { ctx } = setup({ sshHost: HOST });
  await assertRejects(
    () =>
      model.methods.installFtb.execute(
        { vmName: "mc1", packId: "", versionId: "", serverDir: "~/game" },
        ctx,
      ),
    Error,
    "packId is required",
  );
  await assertRejects(
    () =>
      model.methods.installFtb.execute(
        {
          vmName: "mc1",
          packId: "1 && reboot",
          versionId: "",
          serverDir: "~/game",
        },
        ctx,
      ),
    Error,
    "Invalid packId",
  );
});

Deno.test("configure: patches variables.txt and user_jvm_args.txt, accepts EULA", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  const { calls } = await withCommands([
    [/test -f .*variables\.txt/, { stdout: "yes\n" }],
    [/test -f .*user_jvm_args\.txt/, { stdout: "yes\n" }],
  ], () =>
    model.methods.configure.execute(
      { vmName: "mc1", serverDir: "~/game", jvmMemory: "8G" },
      ctx,
    ));
  const cmds = calls.map((c) => c.args.at(-1) ?? "");
  assert(cmds.some((c) => c.includes('JAVA_ARGS="-Xmx8G -Xms8G"')));
  assert(cmds.some((c) => c.includes("-Xmx8G\\n-Xms8G")));
  assert(cmds.some((c) => c === 'echo "eula=true" > ~/game/eula.txt'));
  assertEquals(getWrittenResources()[0].data, {
    jvmMemory: "8G",
    eulaAccepted: true,
    timestamp: getWrittenResources()[0].data.timestamp,
  });
});

Deno.test("configure: invalid jvmMemory fails before any ssh call", async () => {
  const { ctx } = setup({ sshHost: HOST });
  const { calls } = await withCommands([], async () => {
    await assertRejects(
      () =>
        model.methods.configure.execute(
          { vmName: "mc1", serverDir: "~/game", jvmMemory: "8G/;id" },
          ctx,
        ),
      Error,
      "Invalid jvmMemory",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("configure: EULA write failure fails the method", async () => {
  const { ctx, getWrittenResources } = setup({ sshHost: HOST });
  await withCommands([[/eula=true/, {
    code: 1,
    stderr: "Read-only file system",
  }]], async () => {
    await assertRejects(
      () =>
        model.methods.configure.execute(
          { vmName: "mc1", serverDir: "~/game", jvmMemory: "8G" },
          ctx,
        ),
      Error,
      "Read-only file system",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});
