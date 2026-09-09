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
        async command(id, argv, invocation) {
            events.push(`command:${id}:${argv.join("|")}:${invocation.requestId}:${invocation.localOwner}:${invocation.workingDirectory ?? ""}`);
            return { kind: "text", text: "ok" };
        },
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

test("Extension routes expose management reads without a generic RPC surface", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

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

test("Extension command dispatch is CLI-only while lifecycle mutations require local-owner CLI", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));
    const command = operation(module, "command");
    const install = operation(module, "install");
    const reload = operation(module, "reload");
    const remove = operation(module, "remove");

    assert.deepEqual(await command.handle({
        id: "1",
        name: "command",
        payload: { argv: ["--help"], commandId: "example" }
    }, context("cli", "bearer")), { kind: "text", text: "ok" });
    assert.deepEqual(await command.handle({
        id: "1a",
        name: "command",
        payload: { argv: ["provider", "list"], commandId: "example", workingDirectory: "/repo" }
    }, context("cli", "local-owner")), { kind: "text", text: "ok" });
    await assert.rejects(
        async () => await command.handle({
            id: "1b",
            name: "command",
            payload: { argv: [], commandId: "example", workingDirectory: "/repo" }
        }, context("cli", "bearer")),
        /workingDirectory is restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await command.handle({
            id: "2",
            name: "command",
            payload: { argv: [], commandId: "example" }
        }, context("web", "local-owner")),
        /only to CLI clients/iu
    );
    await assert.rejects(
        async () => await reload.handle({ id: "3", name: "reload", payload: { extensionId: "example" } }, context("cli", "bearer")),
        /restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await reload.handle({ id: "4", name: "reload", payload: { extensionId: "example" } }, context("web", "local-owner")),
        /restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await install.handle({ id: "4a", name: "install", payload: { sourcePath: "/tmp/example.dsext" } }, context("cli", "bearer")),
        /restricted to the local owner CLI/iu
    );
    assert.deepEqual(
        await reload.handle({ id: "5", name: "reload", payload: { extensionId: "example" } }, context("cli", "local-owner")),
        record()
    );
    assert.deepEqual(
        await install.handle({ id: "6", name: "install", payload: { sourcePath: "/tmp/example.dsext" } }, context("cli", "local-owner")),
        record()
    );
    assert.deepEqual(
        await remove.handle({ id: "7", name: "remove", payload: { extensionId: "example", purge: true } }, context("cli", "local-owner")),
        { id: "example", purged: true, removed: true }
    );
    assert.deepEqual(events, [
        "command:example:--help:req-1:false:",
        "command:example:provider|list:req-1:true:/repo",
        "reload:example",
        "list",
        "install:/tmp/example.dsext",
        "remove:example:true"
    ]);
});

test("Extension route parser rejects invalid management ids and command payloads before dispatch", async () => {
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
    await assert.rejects(
        async () => await operation(module, "command").handle({
            id: "2",
            name: "command",
            payload: { argv: [], commandId: "Bad_ID" }
        }, context("cli", "local-owner")),
        /commandId must match/iu
    );
    await assert.rejects(
        async () => await operation(module, "command").handle({
            id: "3",
            name: "command",
            payload: { argv: [1], commandId: "example" }
        }, context("cli", "local-owner")),
        /array of strings/iu
    );
    await assert.rejects(
        async () => await operation(module, "command").handle({
            id: "4",
            name: "command",
            payload: { argv: [], commandId: "example", workingDirectory: "relative" }
        }, context("cli", "local-owner")),
        /workingDirectory must be an absolute path/iu
    );
    assert.deepEqual(events, []);
});
