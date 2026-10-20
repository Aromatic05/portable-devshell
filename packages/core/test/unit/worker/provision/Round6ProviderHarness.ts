import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { TestContext } from "node:test";

import type { InstanceContainerConfig } from "@portable-devshell/shared";
import { WorkerBinary } from "../../../../src/instance/runtime/Binary.ts";
import { ContainerExecution } from "../../../../src/instance/runtime/execution/provider/Container.ts";
import { ContainerInstall } from "../../../../src/instance/runtime/provision/install/provider/Container.ts";
import { SshConnection } from "../../../../src/instance/transport/endpoint/channel/Ssh.ts";
import { WorkerInstallerRemote } from "../../../../src/instance/runtime/provision/install/Remote.ts";
import { WorkerAssetResolver } from "../../../../src/instance/runtime/provision/Asset.ts";
import { probeLocalWorkerTarget } from "../../../../src/instance/runtime/provision/Target.ts";

export interface Fault {
    operation: string;
    name?: string;
    contains?: string;
    code?: number;
    message?: string;
    signal?: "SIGTERM";
    gate?: boolean;
    corruptUpload?: boolean;
}
export interface CliCall { operation: string; name: string; args: string[]; keys?: string[]; }
export interface ContainerState { status: "running" | "stopped"; args: string[]; }

export async function providerFixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "round6-provider-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cli = await readFile(new URL("./Round6ProviderCli.mjs", import.meta.url), "utf8");
    const podman = join(root, "fake-podman.mjs");
    const ssh = join(root, "fake-ssh.mjs");
    await writeFile(podman, `#!${process.execPath}\n${cli}`, { mode: 0o755 });
    await writeFile(ssh, `#!${process.execPath}\n${cli}`, { mode: 0o755 });
    await mkdir(join(root, "remote-home"));
    await mkdir(join(root, "remote-tmp"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "sh"), '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
    const worker = join(root, "worker.cjs");
    await writeFile(worker, `#!${process.execPath}\nrequire("node:fs").writeSync(1,JSON.stringify({args:process.argv.slice(2), value:process.env.ROUND6_VALUE, internal:process.env.DEVSHELL_WORKER_INTERNAL_INSTANCE})); process.exitCode=Number(process.env.ROUND6_EXIT ?? 0);\n`, { mode: 0o755 });
    await writeFile(join(root, "calls.jsonl"), "");
    await writeFile(join(root, "containers.json"), "{}");
    return {
        root, worker,
        ssh: () => new SshConnection({ command: `'${ssh}' fixture.invalid` }),
        async faults(faults: Fault[]) { await writeFile(join(root, "faults.json"), JSON.stringify(faults)); },
        async states(): Promise<Record<string, ContainerState>> { return JSON.parse(await readFile(join(root, "containers.json"), "utf8")); },
        async seed(states: Record<string, ContainerState>) { await writeFile(join(root, "containers.json"), JSON.stringify(states)); },
        async calls(): Promise<CliCall[]> { return (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
        async waitForGate() {
            const deadline = Date.now() + 3000;
            while (!existsSync(join(root, "gate-entered")) && Date.now() < deadline) await setTimeout(10);
            assert.equal(existsSync(join(root, "gate-entered")), true, "fake CLI reached deterministic gate");
        },
        async releaseGate() { await writeFile(join(root, "gate-release"), ""); },
        async remoteTemps() { return await readdir(join(root, "remote-tmp")); },
        managed(name: string, overrides: Partial<Extract<InstanceContainerConfig, { mode: "existingImage" }>> = {}) {
            const container: InstanceContainerConfig = { mode: "existingImage", containerName: name, image: "fixture/image:round6", ...overrides };
            const install = new ContainerInstall({ binary: podman, provider: "podman", container, keepIdUserNamespace: true, workerBinary: new WorkerBinary(worker) });
            return { install, execution: new ContainerExecution(install), connection: install.connection };
        },
        async installer(connection: SshConnection) {
            const contents = await readFile(worker);
            const target = probeLocalWorkerTarget();
            const sha256 = createHash("sha256").update(contents).digest("hex");
            // Resolution is pinned to a local asset; the production SSH transport,
            // probe, checksum scripts, upload, alias activation and GC all execute.
            class FixtureResolver extends WorkerAssetResolver {
                override async resolve() { return { binaryPath: worker, searchedPaths: [worker], sha256, source: "env" as const, target }; }
            }
            return { installer: new WorkerInstallerRemote({ connection, provider: "ssh", resolver: new FixtureResolver() }), sha256, target };
        },
    };
}
