import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionRuntimeRecord,
    PrefixRouteContext,
} from "@portable-devshell/shared";
import { routes, type ControlRouteBinding } from "@portable-devshell/extension/control";

import {
    ControlExtensionRouteService,
    createExtensionRouteModule,
    type ExtensionControlPort,
} from "../../../../../src/control/extension/Route.ts";

function context(
    peer: "cli" | "tui" | "web",
    subjectKind: string,
): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        subject: { id: "subject-1", kind: subjectKind },
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
        version: "1.0.0",
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
        },
    };
}

function operation(
    module: ReturnType<typeof createExtensionRouteModule>,
    name: string,
) {
    const found = module.operations.find(
        (candidate) => candidate.name === name,
    );
    if (found === undefined)
        throw new Error(`extension.${name} operation is missing`);
    return found;
}

test("Extension routes expose management reads without command or generic RPC surfaces", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    assert.equal(
        module.operations.some((candidate) => candidate.name === "command"),
        false,
    );
    assert.deepEqual(
        await operation(module, "list").handle(
            { id: "1", name: "list" },
            context("web", "web-session"),
        ),
        [record()],
    );
    assert.deepEqual(
        await operation(module, "get").handle(
            {
                id: "2",
                name: "get",
                payload: { extensionId: "example" },
            },
            context("web", "web-session"),
        ),
        record(),
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
        async () =>
            await reload.handle(
                {
                    id: "1",
                    name: "reload",
                    payload: { extensionId: "example" },
                },
                context("cli", "bearer"),
            ),
        /restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () =>
            await reload.handle(
                {
                    id: "2",
                    name: "reload",
                    payload: { extensionId: "example" },
                },
                context("web", "local-owner"),
            ),
        /restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () =>
            await install.handle(
                {
                    id: "3",
                    name: "install",
                    payload: { sourcePath: "/tmp/example.dsext" },
                },
                context("cli", "bearer"),
            ),
        /restricted to the local owner CLI/iu,
    );
    assert.deepEqual(
        await reload.handle(
            { id: "4", name: "reload", payload: { extensionId: "example" } },
            context("cli", "local-owner"),
        ),
        record(),
    );
    assert.deepEqual(
        await install.handle(
            {
                id: "5",
                name: "install",
                payload: { sourcePath: "/tmp/example.dsext" },
            },
            context("cli", "local-owner"),
        ),
        record(),
    );
    assert.deepEqual(
        await remove.handle(
            {
                id: "6",
                name: "remove",
                payload: { extensionId: "example", purge: true },
            },
            context("cli", "local-owner"),
        ),
        { id: "example", purged: true, removed: true },
    );
    assert.deepEqual(events, [
        "reload:example",
        "list",
        "install:/tmp/example.dsext",
        "remove:example:true",
    ]);
});

test("Extension route parser rejects invalid management ids before dispatch", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    await assert.rejects(
        async () =>
            await operation(module, "get").handle(
                {
                    id: "1",
                    name: "get",
                    payload: { extensionId: "Bad_ID" },
                },
                context("cli", "local-owner"),
            ),
        /extensionId must match/iu,
    );
    assert.deepEqual(events, []);
});

test("Extension route contributions preserve scope, request context, and generation lease", async () => {
    const events: string[] = [];
    const binding: ControlRouteBinding = async (request, invocation) => {
        events.push(
            `invoke:${invocation.destination}:${invocation.peer}:${invocation.requestId}`,
        );
        return {
            payload: request.payload ?? null,
            subject: invocation.subject?.kind ?? null,
        };
    };
    let changed: (() => void) | undefined;
    const service = new ControlExtensionRouteService({
        acquireRegistration: async (pointId: string, id: string) => {
            assert.equal(pointId, routes.id);
            assert.equal(id, "comment-list");
            return {
                extensionId: "comment",
                lease: { release: () => events.push("release") },
                registration: { binding },
            } as never;
        },
        listDeclarations(pointId: string) {
            assert.equal(pointId, routes.id);
            return [
                {
                    declaration: {
                        id: "comment-list",
                        module: "contextMessage",
                        operation: "list",
                        scope: "instance",
                    },
                    extensionId: "comment",
                    generation: "g1",
                },
                {
                    declaration: {
                        id: "preferences-get",
                        module: "conversationPreferences",
                        operation: "get",
                        scope: "control",
                    },
                    extensionId: "comment",
                    generation: "g1",
                },
            ] as never;
        },
        onChange(listener: () => void) {
            changed = listener;
            return () => {
                changed = undefined;
            };
        },
    } as never);

    assert.deepEqual(
        service.modules("control").map((module) => module.name),
        ["conversationPreferences"],
    );
    const modules = service.modules("instance");
    assert.deepEqual(modules.map((module) => module.name), ["contextMessage"]);
    const list = modules[0]!.operations[0]!;
    assert.deepEqual(
        await list.handle(
            { id: "wire-1", name: "list", payload: { ctxId: "ctx-1" } },
            {
                ...context("web", "web-session"),
                destination: "demo",
                module: "contextMessage",
                protocolVersion: "1.0.0",
            },
        ),
        { payload: { ctxId: "ctx-1" }, subject: "web-session" },
    );
    assert.deepEqual(events, ["invoke:demo:web:req-1", "release"]);

    let notifications = 0;
    const unsubscribe = service.onChange(() => {
        notifications += 1;
    });
    changed?.();
    assert.equal(notifications, 1);
    unsubscribe();
    assert.equal(changed, undefined);
});
