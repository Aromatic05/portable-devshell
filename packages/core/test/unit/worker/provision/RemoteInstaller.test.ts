import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    access,
    chmod,
    mkdir,
    readFile,
    readlink,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { RemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import type { WorkerConnection } from "../../../../src/instance/transport/endpoint/channel/worker/index.ts";
import { WorkerInstallerRemote } from "../../../../src/instance/runtime/provision/install/Remote.ts";
import { getWorkerTargetByKey } from "../../../../src/instance/runtime/provision/Target.ts";
import type { WorkerAsset } from "../../../../src/instance/runtime/provision/Asset.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test(
    "WorkerInstallerRemote verifies remote bytes, repairs corruption, and preserves active alias on switch failure",
    {
        skip:
            process.platform === "win32"
                ? "requires POSIX shell and symlinks"
                : false,
    },
    async (t) => {
        const remoteHome = await createTestTempDirectory("remote-worker-home");
        const assets = await createTestTempDirectory("remote-worker-assets");
        t.after(async () => {
            await rm(remoteHome, { recursive: true, force: true });
            await rm(assets, { recursive: true, force: true });
        });
        const target = getWorkerTargetByKey("linux-x64");
        const first = await writeAsset(assets, "worker-v1", target);
        const firstInstaller = createInstaller(
            remoteHome,
            first,
            target,
            process.env.PATH ?? "",
        );
        const executable = await firstInstaller.ensure("devshell-worker");
        const previousTarget = await readlink(executable);

        const installed = join(
            remoteHome,
            ".devshell",
            "workers",
            target.key,
            first.sha256,
            "devshell-worker",
        );
        await writeFile(installed, "corrupt", "utf8");
        await firstInstaller.ensure("devshell-worker");
        assert.equal(await readFile(installed, "utf8"), "worker-v1");

        const realMv = spawnSync("sh", ["-lc", "command -v mv"], {
            encoding: "utf8",
        }).stdout.trim();
        assert.notEqual(realMv, "");
        const fakeBin = join(remoteHome, "fake-bin");
        await mkdir(fakeBin, { recursive: true });
        const fakeMv = join(fakeBin, "mv");
        await writeFile(
            fakeMv,
            [
                "#!/bin/sh",
                'case "$*" in',
                "  *.next.*) echo injected-alias-switch-failure >&2; exit 73 ;;",
                "esac",
                `exec '${realMv.replaceAll("'", `'\\''`)}' "$@"`,
                "",
            ].join("\n"),
        );
        await chmod(fakeMv, 0o755);

        const second = await writeAsset(assets, "worker-v2", target);
        const secondInstaller = createInstaller(
            remoteHome,
            second,
            target,
            `${fakeBin}:${process.env.PATH ?? ""}`,
        );
        await assert.rejects(
            secondInstaller.ensure("devshell-worker"),
            (error: unknown) =>
                error instanceof RemoteError &&
                error.cause instanceof Error &&
                /injected-alias-switch-failure/u.test(error.cause.message),
        );
        assert.equal(await readlink(executable), previousTarget);
    },
);

test(
    "WorkerInstallerRemote prunes stale sha generations after install and current-worker inspection",
    {
        skip:
            process.platform === "win32"
                ? "requires POSIX shell and symlinks"
                : false,
    },
    async (t) => {
        const remoteHome = await createTestTempDirectory(
            "remote-worker-gc-home",
        );
        const assets = await createTestTempDirectory("remote-worker-gc-assets");
        t.after(async () => {
            await rm(remoteHome, { recursive: true, force: true });
            await rm(assets, { recursive: true, force: true });
        });

        const target = getWorkerTargetByKey("linux-x64");
        const generations = join(
            remoteHome,
            ".devshell",
            "workers",
            target.key,
        );
        const staleInstall = join(generations, "a".repeat(64));
        const recent = join(generations, "b".repeat(64));
        const unknown = join(generations, "manual-backup");
        await Promise.all([
            mkdir(staleInstall, { recursive: true }),
            mkdir(recent, { recursive: true }),
            mkdir(unknown, { recursive: true }),
        ]);
        const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
        await Promise.all([
            utimes(staleInstall, old, old),
            utimes(unknown, old, old),
        ]);

        const asset = await writeAsset(assets, "worker-current", target);
        const installer = createInstaller(
            remoteHome,
            asset,
            target,
            process.env.PATH ?? "",
        );
        await installer.ensure("devshell-worker");

        await assert.rejects(access(staleInstall));
        await assert.doesNotReject(access(recent));
        await assert.doesNotReject(access(unknown));
        const currentGeneration = join(generations, asset.sha256);
        await assert.doesNotReject(access(currentGeneration));

        const staleInspect = join(generations, "c".repeat(64));
        await mkdir(staleInspect, { recursive: true });
        await utimes(staleInspect, old, old);
        await installer.ensure("devshell-worker");
        await assert.rejects(access(staleInspect));

        await utimes(currentGeneration, old, old);
        await installer.ensure("devshell-worker");
        const next = await writeAsset(assets, "worker-next", target);
        await createInstaller(
            remoteHome,
            next,
            target,
            process.env.PATH ?? "",
        ).ensure("devshell-worker");
        await assert.doesNotReject(access(currentGeneration));
    },
);

function createInstaller(
    home: string,
    asset: WorkerAsset,
    target: ReturnType<typeof getWorkerTargetByKey>,
    path: string,
): WorkerInstallerRemote {
    return new WorkerInstallerRemote({
        resolver: { resolve: async () => asset } as never,
        provider: "test-remote",
        connection: {
            async runCommand(operation, command, options) {
                const child = spawn(command[0]!, command.slice(1), {
                    env: { ...process.env, HOME: home, PATH: path },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                child.stdout.setEncoding("utf8");
                child.stderr.setEncoding("utf8");
                child.stdout.on("data", (chunk: string) => {
                    stdout += chunk;
                });
                child.stderr.on("data", (chunk: string) => {
                    stderr += chunk;
                });
                if (options?.input !== undefined)
                    child.stdin.end(options.input);
                else child.stdin.end();
                return await new Promise((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", (exitCode, signal) =>
                        resolve({
                            details: {
                                command: [...command],
                                commandDisplay: command.join(" "),
                                operation,
                                provider: "test-remote",
                                ...(signal === null ? {} : { signal }),
                                ...(stderr.length === 0
                                    ? {}
                                    : { stderrTail: stderr }),
                                ...(stdout.length === 0
                                    ? {}
                                    : { stdoutTail: stdout }),
                                exitCode,
                            },
                            exitCode,
                            signal: signal ?? undefined,
                            stderr,
                            stdout,
                        }),
                    );
                });
            },
            async openChannel() {
                throw new Error("not used by WorkerInstallerRemote tests");
            },
        } satisfies WorkerConnection,
    });
}

async function writeAsset(
    directory: string,
    contents: string,
    target: ReturnType<typeof getWorkerTargetByKey>,
): Promise<WorkerAsset> {
    const binaryPath = join(directory, contents);
    const bytes = Buffer.from(contents, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(binaryPath, bytes, { mode: 0o755 });
    return {
        binaryPath,
        searchedPaths: [binaryPath],
        sha256,
        source: "env",
        target,
    };
}
