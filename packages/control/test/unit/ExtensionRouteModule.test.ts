import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionRuntimeRecord,
    PrefixRouteContext
} from "@portable-devshell/shared";

import {
    createExtensionRouteModule,
    type ExtensionControlPort
} from "../../src/control/extension/route/ExtensionRouteModule.ts";

function context(peer: "cli" | "tui" | "web", subjectKind: string): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        subject: { id: "subject-1", kind: subjectKind }
    } as PrefixRouteContext;
}

function record(enabled = true): ExtensionRuntimeRecord {
    return {
        activeGeneration: enabled ? "g1" : undefined,
        enabled,
        id: "example",
        retired: [],
        selectedGeneration: "g1",
        state: enabled ? "active" : "disabled",
        version: "1.0.0"
    };
}

function port(events: string[] = []): ExtensionControlPort {
    let enabled = true;
    return {
        async disable(id) {
            events.push(`disable:${id}`);
            enabled = false;
        },
        async enable(id) {
            events.push(`enable:${id}`);
            enabled = true;
        },
        async install(sourcePath) {
            events.push(`install:${sourcePath}`);
            return record();
        },
        async list() {
            events.push("list");
            return [record(enabled)];
        },
        async reload(id) {
            events.push(`reload:${id}`);
        },
        async remove(id, purge) {
            events.push(`remove:${id}:${purge}`);
            return { id, purged: purge, removed: true };
        }
    };
}

function operation(module: ReturnType<typeof createExtensionRouteModule>, name: string) {
    const found = module.operations.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`extension.${name} operation is missing`);
    return found;
}

test("Extension routes expose management reads without command or generic RPC surfaces", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    assert.equal(module.operations.some((candidate) => candidate.name === "command"), false);
    assert.deepEqual(
        await operation(module, "list").handle({ id: "1", name: "list" }, context("web", "web-session")),
        [record()]
    );
    assert.deepEqual(
        await operation(module, "get").handle({
            id: "2",
            name: "get",
            payload: { extensionId: "example" }
        }, context("web", "web-session")),
        record()
    );
    assert.deepEqual(events, ["list", "list"]);
});

test("Extension lifecycle mutations require local-owner CLI", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));
    const install = operation(module, "install");
    const reload = operation(module, "reload");
    const remove = operation(module, "remove");

    await assert.rejects(
        async () => await reload.handle({ id: "1", name: "reload", payload: { extensionId: "example" } }, context("cli", "bearer")),
        /restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await reload.handle({ id: "2", name: "reload", payload: { extensionId: "example" } }, context("web", "local-owner")),
        /restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await install.handle({ id: "3", name: "install", payload: { sourcePath: "/tmp/example.dsext" } }, context("cli", "bearer")),
        /restricted to the local owner CLI/iu
    );
    assert.deepEqual(
        await reload.handle({ id: "4", name: "reload", payload: { extensionId: "example" } }, context("cli", "local-owner")),
        record()
    );
    assert.deepEqual(
        await install.handle({ id: "5", name: "install", payload: { sourcePath: "/tmp/example.dsext" } }, context("cli", "local-owner")),
        record()
    );
    assert.deepEqual(
        await remove.handle({ id: "6", name: "remove", payload: { extensionId: "example", purge: true } }, context("cli", "local-owner")),
        { id: "example", purged: true, removed: true }
    );
    assert.deepEqual(events, [
        "reload:example",
        "list",
        "install:/tmp/example.dsext",
        "remove:example:true"
    ]);
});

test("Extension route parser rejects invalid management ids before dispatch", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    await assert.rejects(
        async () => await operation(module, "get").handle({
            id: "1",
            name: "get",
            payload: { extensionId: "Bad_ID" }
        }, context("cli", "local-owner")),
        /extensionId must match/iu
    );
    assert.deepEqual(events, []);
});
