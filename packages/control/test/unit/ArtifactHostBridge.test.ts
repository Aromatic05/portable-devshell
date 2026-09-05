import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ArtifactPayloadDescriptor, JsonValue } from "@portable-devshell/shared";
import { ArtifactHostBridge, type ArtifactHostAccessContext } from "@portable-devshell/control/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

function context(overrides?: Partial<ArtifactHostAccessContext>): ArtifactHostAccessContext {
    return {
        appendControlEvent: async (_type: string, _data?: JsonValue) => undefined,
        authorityInstance: "demo-local",
        provider: "local",
        securityMode: "disabled",
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

async function fixture(t: TestContext) {
    const root = await createTestTempDirectory("artifact-host");
    const homeDirectory = join(root, "home");
    const storageDir = join(root, "storage");
    await mkdir(homeDirectory, { recursive: true });
    const bridge = new ArtifactHostBridge({ homeDirectory, storageDir });
    await bridge.initialize();
    t.after(() => rm(root, { force: true, recursive: true }));
    return { bridge, homeDirectory, root, storageDir };
}

test("host source snapshots arbitrary paths when security is disabled and persists across bridge restart", async (t) => {
    const { bridge, root, storageDir, homeDirectory } = await fixture(t);
    const source = join(root, "outside.bin");
    await writeFile(source, Buffer.from("before"));
    const endpoint = bridge.endpointFor(context());
    const opened = await endpoint.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: source, workspace: root });
    await writeFile(source, Buffer.from("after"));

    const reopenedBridge = new ArtifactHostBridge({ homeDirectory, storageDir });
    await reopenedBridge.initialize();
    const reopenedEndpoint = reopenedBridge.endpointFor(context());
    assert.equal(
        (await readPayload(reopenedEndpoint, opened.payloadId, opened.descriptor.payloadBytes)).toString(),
        "before"
    );
    await reopenedEndpoint.closeArtifactPayload(opened.payloadId);
});

test("host receive initialization cleans only its private staging directory", async (t) => {
    const root = await createTestTempDirectory("artifact-host-receive-init-");
    const homeDirectory = join(root, "home");
    const downloadDirectory = join(homeDirectory, "Download");
    const storageDir = join(root, "storage");
    const stagingDirectory = join(downloadDirectory, ".devshell-receive");
    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(join(downloadDirectory, "unrelated.txt"), "keep");
    await writeFile(join(stagingDirectory, "orphan.payload"), "remove");

    const bridge = new ArtifactHostBridge({ homeDirectory, storageDir });
    await bridge.initialize();

    assert.equal(await readFile(join(downloadDirectory, "unrelated.txt"), "utf8"), "keep");
    await assert.rejects(readFile(join(stagingDirectory, "orphan.payload"), "utf8"), { code: "ENOENT" });
    t.after(() => rm(root, { force: true, recursive: true }));
});

test("host source workspace mode permits only a local provider workspace and rejects link escapes", async (t) => {
    const { bridge, root } = await fixture(t);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const outsideDirectory = join(root, "outside-directory");
    await mkdir(workspace);
    await mkdir(outsideDirectory);
    await writeFile(join(workspace, "inside.txt"), "inside");
    await writeFile(outside, "outside");
    await writeFile(join(outsideDirectory, "linked.txt"), "linked outside");
    const linkPath = join(workspace, "link");
    if (process.platform === "win32") {
        await symlink(outsideDirectory, linkPath, "junction");
    } else {
        await symlink(outsideDirectory, linkPath, "dir");
    }
    const local = bridge.endpointFor(context({ provider: "local", securityMode: "workspace" }));

    const inside = await local.openArtifactPayload({
        expiresAtMs: Date.now() + 60_000,
        path: join(workspace, "inside.txt"),
        workspace
    });
    assert.equal((await readPayload(local, inside.payloadId, inside.descriptor.payloadBytes)).toString(), "inside");
    await assert.rejects(
        local.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: outside, workspace }),
        hasCode("artifact.hostPathDenied")
    );
    await assert.rejects(
        local.openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            path: join(linkPath, "linked.txt"),
            workspace
        }),
        hasAnyCode("artifact.directoryUnsafe", "artifact.hostPathDenied")
    );

    const remote = bridge.endpointFor(context({ provider: "ssh", securityMode: "workspace" }));
    await assert.rejects(
        remote.openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            path: join(workspace, "inside.txt"),
        workspace
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
        targetPath: "../../etc/passwd",
        workspace: homeDirectory
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
    const opened = await endpoint.openArtifactPayload({ expiresAtMs: Date.now() + 60_000, path: source, workspace: root });
    assert.equal(opened.descriptor.type, "directoryArchive");
    const archive = await readPayload(endpoint, opened.payloadId, opened.descriptor.payloadBytes);
    const receive = await endpoint.beginArtifactReceive({
        descriptor: opened.descriptor,
        overwrite: false,
        targetPath: "/srv/app",
        workspace: root
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
            sourceWorkspace: root,
            targetInstance: "host",
            targetPath: "/ignored/copy.txt",
            targetWorkspace: homeDirectory
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

function hasAnyCode(...codes: string[]): (error: unknown) => boolean {
    return (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        codes.includes(error.code);
}