import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ArtifactPayloadDescriptor, JsonValue } from "@portable-devshell/shared";
import { ArtifactHostBridge, type ArtifactHostAccessContext } from "@portable-devshell/control/testing";

function context(overrides?: Partial<ArtifactHostAccessContext>): ArtifactHostAccessContext {
    return {
        appendControlEvent: async (_type: string, _data?: JsonValue) => undefined,
        authorityInstance: "demo-local",
        provider: "local",
        securityMode: "disabled",
        workspace: undefined,
        ...overrides
    };
}

function fileDescriptor(bytes: Buffer, name = "payload.bin"): ArtifactPayloadDescriptor {
    return {
        mediaType: "application/octet-stream",
        name,
        payloadBlake3: "placeholder",
        payloadBytes: bytes.length,
        type: "file"
    };
}

async function readPayload(endpoint: ReturnType<ArtifactHostBridge["endpointFor"]>, payloadId: string, bytes: number) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < bytes) {
        const chunk = await endpoint.readArtifactPayload({
            maxBytes: Math.min(3, bytes - offset),
            offsetBytes: offset,
            payloadId
        });
        chunks.push(Buffer.from(chunk.content, "base64"));
        offset += chunk.returnedBytes;
    }
    return Buffer.concat(chunks);
}

async function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
    const root = await mkdtemp(join(tmpdir(), "artifact-host-"));
    const homeDirectory = join(root, "home");
    const processCwd = join(root, "cwd");
    const storageDir = join(root, "storage");
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(processCwd, { recursive: true });
    const bridge = new ArtifactHostBridge({ homeDirectory, processCwd, storageDir });
    await bridge.initialize();
    t.after(() => rm(root, { force: true, recursive: true }));
    return { bridge, homeDirectory, processCwd, root, storageDir };
}

test("host source snapshots arbitrary paths when security is disabled and persists across bridge restart", async (t) => {
    const { bridge, root, storageDir, homeDirectory, processCwd } = await fixture(t);
    const source = join(root, "outside.bin");
    await writeFile(source, Buffer.from("before"));
    const endpoint = bridge.endpointFor(context());
    const opened = await endpoint.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: source });
    await writeFile(source, Buffer.from("after"));

    const reopenedBridge = new ArtifactHostBridge({ homeDirectory, processCwd, storageDir });
    await reopenedBridge.initialize();
    const reopenedEndpoint = reopenedBridge.endpointFor(context());
    assert.equal(
        (await readPayload(reopenedEndpoint, opened.payloadId, opened.descriptor.payloadBytes)).toString(),
        "before"
    );
    await reopenedEndpoint.closeArtifactPayload(opened.payloadId);
});

test("host source workspace mode permits only a local provider workspace and rejects symlinks", { skip: process.platform === "win32" ? "requires Unix symlink semantics" : false }, async (t) => {
    const { bridge, root } = await fixture(t);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside");
    await writeFile(outside, "outside");
    await symlink(outside, join(workspace, "link.txt"));
    const local = bridge.endpointFor(context({ provider: "local", securityMode: "workspace", workspace }));

    const inside = await local.openArtifactPayload({
        expiresAtMs: Date.now() + 60_000,
        path: join(workspace, "inside.txt")
    });
    assert.equal((await readPayload(local, inside.payloadId, inside.descriptor.payloadBytes)).toString(), "inside");
    await assert.rejects(
        local.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: outside }),
        hasCode("artifact.hostPathDenied")
    );
    await assert.rejects(
        local.openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            path: join(workspace, "link.txt")
        }),
        hasCode("artifact.directoryUnsafe")
    );

    const remote = bridge.endpointFor(context({ provider: "ssh", securityMode: "workspace", workspace }));
    await assert.rejects(
        remote.openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            path: join(workspace, "inside.txt")
        }),
        hasCode("artifact.hostPathDenied")
    );
});

test("host source rejects artifact handles", async (t) => {
    const { bridge } = await fixture(t);
    await assert.rejects(
        bridge.endpointFor(context()).openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            handle: "worker-artifact-handle"
        }),
        hasCode("artifact.hostHandleUnsupported")
    );
});

test("host target redirects any path to a direct child of ~/Download", async (t) => {
    const { bridge, homeDirectory } = await fixture(t);
    const endpoint = bridge.endpointFor(context());
    const bytes = Buffer.from("host target");
    const descriptor = fileDescriptor(bytes, "fallback.bin");
    descriptor.payloadBlake3 = await bridge.blake3(bytes);
    const receive = await endpoint.beginArtifactReceive({
        descriptor,
        overwrite: false,
        targetPath: "../../etc/passwd"
    });
    await endpoint.writeArtifactReceive({
        content: bytes.toString("base64"),
        offsetBytes: 0,
        receiveId: receive.receiveId
    });
    const finished = await endpoint.finishArtifactReceive(receive.receiveId);

    assert.equal(finished.targetPath, join(homeDirectory, "Download", "passwd"));
    assert.equal(await readFile(finished.targetPath, "utf8"), "host target");
});

test("host directory payload round-trips through tar.zst and restores executable mode", async (t) => {
    const { bridge, homeDirectory, root } = await fixture(t);
    const source = join(root, "dist");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "index.html"), "index");
    await writeFile(join(source, "assets", "app.sh"), "#!/bin/sh\necho app\n");
    if (process.platform !== "win32") {
        await chmod(join(source, "assets", "app.sh"), 0o755);
    }
    const endpoint = bridge.endpointFor(context());
    const opened = await endpoint.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: source });
    assert.equal(opened.descriptor.type, "directoryArchive");
    const archive = await readPayload(endpoint, opened.payloadId, opened.descriptor.payloadBytes);
    const receive = await endpoint.beginArtifactReceive({
        descriptor: opened.descriptor,
        overwrite: false,
        targetPath: "/srv/app"
    });
    await endpoint.writeArtifactReceive({
        content: archive.toString("base64"),
        offsetBytes: 0,
        receiveId: receive.receiveId
    });
    await endpoint.finishArtifactReceive(receive.receiveId);

    assert.equal(await readFile(join(homeDirectory, "Download", "app", "index.html"), "utf8"), "index");
    if (process.platform !== "win32") {
        assert.equal((await stat(join(homeDirectory, "Download", "app", "assets", "app.sh"))).mode & 0o777, 0o755);
    }
});

test("artifact service routes hidden host source and target with the real authority instance", async (t) => {
    const { bridge, homeDirectory, root } = await fixture(t);
    const source = join(root, "host-source.txt");
    await writeFile(source, "host bridge");
    const authority = context();
    const authorities: Array<string | undefined> = [];
    const { ArtifactService } = await import("@portable-devshell/control/testing");
    const service = new ArtifactService({
        resolveEndpoint: (name, authorityInstance) => {
            authorities.push(authorityInstance);
            return name === "host" && authorityInstance === authority.authorityInstance
                ? bridge.endpointFor(authority)
                : undefined;
        },
        shareUrl: (token) => `http://localhost/artifacts/share/${token}`,
        storageDir: join(root, "service")
    });
    await service.initialize();
    t.after(() => service.stop());

    const started = await service.startTransfer(
        {
            instance: "host",
            operation: "start",
            sourcePath: source,
            targetInstance: "host",
            targetPath: "/ignored/copy.txt"
        },
        authority.authorityInstance
    );
    const completed = await service.waitForTransfer(started.transfer.transferId);
    assert.equal(completed.status, "completed");
    assert.equal(await readFile(join(homeDirectory, "Download", "copy.txt"), "utf8"), "host bridge");
    assert.ok(authorities.length >= 2);
    assert.ok(authorities.every((value) => value === authority.authorityInstance));
});

function hasCode(code: string): (error: unknown) => boolean {
    return (error) =>
        typeof error === "object" && error !== null && "code" in error && error.code === code;
}