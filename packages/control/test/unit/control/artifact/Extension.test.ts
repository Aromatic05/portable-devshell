import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    createDefaultControlConfig,
    type ArtifactPayloadDescriptor,
    type JsonValue,
} from "@portable-devshell/shared";

import { createArtifactRuntime } from "../../../../src/artifact/index.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

class MemoryArtifactReceiver {
    readonly events: string[] = [];
    readonly chunks: Buffer[] = [];
    #descriptor?: ArtifactPayloadDescriptor;

    async appendControlEvent(type: string, _data?: JsonValue): Promise<void> {
        this.events.push(type);
    }

    async beginArtifactReceive(input: {
        descriptor: ArtifactPayloadDescriptor;
    }) {
        this.#descriptor = input.descriptor;
        this.chunks.length = 0;
        return { nextOffsetBytes: 0, receiveId: "receive-1" };
    }

    async writeArtifactReceive(input: {
        bytes: Uint8Array;
        offsetBytes: number;
        receiveId: string;
    }) {
        assert.equal(input.receiveId, "receive-1");
        const bytes = Buffer.from(input.bytes);
        assert.equal(input.offsetBytes, Buffer.concat(this.chunks).length);
        this.chunks.push(bytes);
        return {
            nextOffsetBytes: input.offsetBytes + bytes.length,
            receiveId: input.receiveId,
            receivedBytes: bytes.length,
        };
    }

    async finishArtifactReceive(receiveId: string) {
        assert.equal(receiveId, "receive-1");
        const descriptor = this.#descriptor;
        assert.notEqual(descriptor, undefined);
        return {
            blake3: descriptor!.payloadBlake3,
            bytes: Buffer.concat(this.chunks).length,
            receiveId,
            targetPath: "/remote/skill",
        };
    }

    async abortArtifactReceive(_receiveId: string): Promise<void> {}
    async closeArtifactPayload(_payloadId: string): Promise<void> {}
    async openArtifactPayload(): Promise<never> {
        throw new Error("target-only endpoint");
    }
    async readArtifactPayload(): Promise<never> {
        throw new Error("target-only endpoint");
    }
}

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory(
        "control-runtime-artifact-extension",
    );
    const home = join(root, "home");
    const source = join(root, "asset");
    await mkdir(home, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Review\n", "utf8");
    const target = new MemoryArtifactReceiver();
    const config = createDefaultControlConfig();
    const runtime = createArtifactRuntime({
        config: () => config,
        controlPaths: new ControlPathHome(home),
        homeDirectory: home,
        instances: {
            get(name: string) {
                return name === "remote-one"
                    ? { worker: { artifact: target } }
                    : undefined;
            },
        } as never,
    });
    await runtime.start();
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });
    return { runtime, source, target };
}

test("Artifact runtime transfers a Control-owned directory through the host endpoint", async (t) => {
    const h = await harness(t);

    const result = await h.runtime.transferHostPath(
        h.source,
        {
            instance: "remote-one",
            path: "./review",
            workspace: "/remote/skills",
        },
    );

    assert.equal(
        result.transferredBytes,
        Buffer.concat(h.target.chunks).length,
    );
    assert.ok(result.transferredBytes > 0);
    assert.equal(result.status, "completed");
    assert.equal(h.target.events.includes("artifact.transferCompleted"), false);
});

test("Artifact callers cannot forge the private host transfer authority", async (t) => {
    const h = await harness(t);

    await assert.rejects(
        h.runtime.service.startTransfer(
            {
                instance: "host",
                operation: "start",
                sourcePath: h.source,
                sourceWorkspace: h.source,
                targetInstance: "remote-one",
                targetPath: "./review",
                targetWorkspace: "/remote/skills",
            },
            "@host-artifact:guessed",
        ),
        /Instance host was not found/u,
    );
});

test("Artifact startup can be retried after initialization is repaired", async (t) => {
    const root = await createTestTempDirectory(
        "control-runtime-artifact-retry",
    );
    const home = join(root, "home");
    const artifacts = join(home, ".devshell", "control", "artifacts");
    await mkdir(join(artifacts, "shares"), { recursive: true });
    await writeFile(join(artifacts, "transfers"), "blocked", "utf8");
    const config = createDefaultControlConfig();
    const runtime = createArtifactRuntime({
        config: () => config,
        controlPaths: new ControlPathHome(home),
        homeDirectory: home,
        instances: {
            get() {
                return undefined;
            },
        } as never,
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });

    await assert.rejects(runtime.start());
    await runtime.stop();
    await rm(join(artifacts, "transfers"));
    await runtime.start();
    assert.ok(runtime.service);
});
