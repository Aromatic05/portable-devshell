import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    createDefaultControlConfig,
    type ArtifactPayloadDescriptor,
    type JsonValue
} from "@portable-devshell/shared";

import { ControlRuntimeArtifact } from "../../src/composition/runtime/ControlRuntimeArtifact.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

class MemoryArtifactReceiver {
    readonly events: string[] = [];
    readonly chunks: Buffer[] = [];
    #descriptor?: ArtifactPayloadDescriptor;

    async appendControlEvent(type: string, _data?: JsonValue): Promise<void> {
        this.events.push(type);
    }

    async beginArtifactReceive(input: { descriptor: ArtifactPayloadDescriptor }) {
        this.#descriptor = input.descriptor;
        this.chunks.length = 0;
        return { nextOffsetBytes: 0, receiveId: "receive-1" };
    }

    async writeArtifactReceive(input: { content: string; offsetBytes: number; receiveId: string }) {
        assert.equal(input.receiveId, "receive-1");
        const bytes = Buffer.from(input.content, "base64");
        assert.equal(input.offsetBytes, Buffer.concat(this.chunks).length);
        this.chunks.push(bytes);
        return {
            nextOffsetBytes: input.offsetBytes + bytes.length,
            receiveId: input.receiveId,
            receivedBytes: bytes.length
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
            targetPath: "/remote/skill"
        };
    }

    async abortArtifactReceive(_receiveId: string): Promise<void> {}
    async closeArtifactPayload(_payloadId: string): Promise<void> {}
    async openArtifactPayload(): Promise<never> { throw new Error("target-only endpoint"); }
    async readArtifactPayload(): Promise<never> { throw new Error("target-only endpoint"); }
}

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("control-runtime-artifact-extension");
    const home = join(root, "home");
    const source = join(root, "asset");
    await mkdir(home, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Review\n", "utf8");
    const target = new MemoryArtifactReceiver();
    const config = createDefaultControlConfig();
    const runtime = new ControlRuntimeArtifact({
        config: () => config,
        controlPaths: new ControlPathHome(home),
        homeDirectory: home,
        instances: {
            get(name: string) {
                return name === "remote-one" ? { worker: target } : undefined;
            }
        } as never
    });
    await runtime.start();
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });
    return { runtime, source, target };
}

test("Extension assets use the Artifact core to transfer a Control-owned directory", async (t) => {
    const h = await harness(t);

    const result = await h.runtime.transferExtensionAsset("skill", {
        sourcePath: h.source,
        target: {
            instance: "remote-one",
            path: "./review",
            workspace: "/remote/skills"
        }
    });

    assert.match(result.transferId, /^[0-9a-f-]{36}$/u);
    assert.equal(result.transferredBytes, Buffer.concat(h.target.chunks).length);
    assert.ok(result.transferredBytes > 0);
    assert.equal(h.target.events.includes("artifact.transferCompleted"), true);
});

test("Artifact callers cannot forge the private Extension host authority", async (t) => {
    const h = await harness(t);

    await assert.rejects(
        h.runtime.service.startTransfer({
            instance: "host",
            operation: "start",
            sourcePath: h.source,
            sourceWorkspace: h.source,
            targetInstance: "remote-one",
            targetPath: "./review",
            targetWorkspace: "/remote/skills"
        }, "@extension-asset:guessed"),
        /Instance host was not found/u
    );
});
