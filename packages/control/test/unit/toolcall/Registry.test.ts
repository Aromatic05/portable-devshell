import assert from "node:assert/strict";
import test from "node:test";

import { createToolCallRuntime, type JsonValue, type ToolDefinition } from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import {
    createToolCallRegistry,
    installInstanceToolDefinitions,
} from "../../../src/toolcall/index.ts";

const environInfo = tool("environ_info");
const bashRun = tool("bash_run", ["execute"]);
const fileRead = tool("file_read", ["read"]);
const todoRead = tool("todo_read");

test("ToolCallRegistry overlays global definitions onto each instance", () => {
    const registry = createToolCallRegistry();
    const control = registry.registerAll([environInfo]);
    const worker = registry.register("local", [bashRun]);

    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["environ_info", "bash_run"],
    );
    assert.deepEqual(
        registry.list("remote").map((entry) => entry.definition.name),
        ["environ_info"],
    );

    worker.replace([fileRead]);
    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["environ_info", "file_read"],
    );

    control.dispose();
    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["file_read"],
    );
});

test("ToolCallRegistry rejects overlapping duplicate names atomically", () => {
    const registry = createToolCallRegistry();
    registry.registerAll([todoRead]);
    assert.throws(
        () => registry.register("local", [todoRead]),
        /more than once/iu,
    );

    const local = registry.register("local", [bashRun]);
    registry.register("remote", [bashRun]);
    assert.throws(() => local.replace([todoRead]), /more than once/iu);
    assert.equal(
        registry.get("local", "bash_run")?.definition.name,
        "bash_run",
    );
});

test("ToolCallRegistry validates namespace groups", () => {
    const registry = createToolCallRegistry();
    assert.throws(
        () => registry.register("local", [{ ...bashRun, group: "file" }]),
        /namespace/iu,
    );
});

test("instance catalog bridge projects catalogs and follows refresh", () => {
    const registry = createToolCallRegistry();
    const control = registry.registerAll([environInfo]);
    const source = catalogSource("local");
    const changes = changeHub();
    const stop = installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: existingInstances(() => [source.instance]),
    });

    assert.deepEqual(names(registry, "local"), ["environ_info"]);

    const worker = source.toolDefinitions.register([bashRun]);
    assert.deepEqual(names(registry, "local"), ["environ_info", "bash_run"]);

    worker.replace([fileRead]);
    assert.deepEqual(names(registry, "local"), ["environ_info", "file_read"]);

    stop();
    control.dispose();
    assert.deepEqual(names(registry, "local"), []);
});

test("instance catalog bridge retires removed and replaced instances", () => {
    const registry = createToolCallRegistry();
    const first = catalogSource("local");
    const sources: Array<{
        instance: ReturnType<typeof catalogSource>["instance"];
    }> = [{ instance: first.instance }];
    const changes = changeHub();
    installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: existingInstances(() => sources.map((entry) => entry.instance)),
    });
    const firstWorker = first.toolDefinitions.register([bashRun]);
    assert.deepEqual(names(registry, "local"), ["bash_run"]);

    const second = catalogSource("local");
    sources[0] = { instance: second.instance };
    changes.publish();
    assert.deepEqual(names(registry, "local"), []);

    firstWorker.replace([fileRead]);
    assert.deepEqual(names(registry, "local"), []);
    const secondWorker = second.toolDefinitions.register([fileRead]);
    assert.deepEqual(names(registry, "local"), ["file_read"]);

    sources.length = 0;
    changes.publish();
    assert.deepEqual(names(registry, "local"), []);

    secondWorker.replace([bashRun]);
    assert.deepEqual(names(registry, "local"), []);
});

test("instance catalog bridge ignores instances without MCP", () => {
    const registry = createToolCallRegistry();
    const source = catalogSource("local", { mcpEnabled: false });
    installInstanceToolDefinitions({
        changes: changeHub(),
        hooks: registry,
        instances: existingInstances(() => [source.instance]),
    });

    source.toolDefinitions.register([bashRun]);
    assert.deepEqual(names(registry, "local"), []);
});

test("instance add fails before commit when ToolCall injection conflicts", () => {
    const registry = createToolCallRegistry();
    const instances = new InstanceRegistry([]);
    const changes = new InstanceChangeHub();
    const definitions = registry.registerAll([environInfo]);
    const stop = installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances,
    });
    const conflict = catalogSource("collision");
    conflict.toolDefinitions.register([environInfo]);
    try {
        assert.throws(
            () => instances.add(conflict.instance as unknown as Instance),
            /more than once/iu,
        );
        assert.equal(instances.get("collision"), undefined);
        assert.deepEqual(conflict.toolDefinitions.list().map((tool) => tool.name), ["environ_info"]);
    } finally {
        stop();
        definitions.dispose();
        conflict.runtime.close();
    }
});

test("instance add rolls back installed tools and hooks when a later initializer fails", async () => {
    const registry = createToolCallRegistry();
    const instances = new InstanceRegistry([]);
    const source = catalogSource("rejected");
    const definitions = registry.registerAll([environInfo]);
    const unregisterExecute = registry.registerExecute("environ_info", async () => "ok");
    let reviews = 0;
    const unregisterReview = registry.registerReview({
        hook: "400-precommit-review",
        id: "precommit-review",
        review: () => {
            reviews += 1;
            return { decision: "continue" };
        },
    });
    const stop = installInstanceToolDefinitions({
        changes: new InstanceChangeHub(),
        hooks: registry,
        instances,
    });
    const stopFailing = instances.onAdding(() => { throw new Error("initializer failed"); });
    try {
        assert.throws(() => instances.add(source.instance as unknown as Instance), /initializer failed/u);
        assert.equal(instances.get("rejected"), undefined);
        assert.deepEqual(source.toolDefinitions.list(), []);
        await assert.rejects(source.runtime.api.call("rejected", "environ_info", {}, { source: "mcp" }), /no execute/iu);
        assert.equal(reviews, 0);
    } finally {
        stopFailing();
        stop();
        unregisterReview();
        unregisterExecute();
        definitions.dispose();
        source.runtime.close();
    }
});

test("instance catalog bridge follows MCP enablement and preserves conflicts", () => {
    const registry = createToolCallRegistry();
    registry.registerAll([environInfo]);
    const source = catalogSource("local");
    const changes = changeHub();
    installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: existingInstances(() => [source.instance]),
    });

    source.toolDefinitions.register([bashRun]);
    assert.deepEqual(names(registry, "local"), ["environ_info", "bash_run"]);

    source.setMcpEnabled(false);
    changes.publish();
    assert.deepEqual(names(registry, "local"), ["environ_info"]);

    source.setMcpEnabled(true);
    changes.publish();
    assert.deepEqual(names(registry, "local"), ["environ_info", "bash_run"]);

    assert.throws(
        () => source.toolDefinitions.register([environInfo]),
        /more than once/iu,
    );
    assert.deepEqual(names(registry, "local"), ["environ_info", "bash_run"]);
});

test("control hooks and executes move with an instance generation", async () => {
    const registry = createToolCallRegistry();
    const first = catalogSource("local");
    const second = catalogSource("local");
    const changes = changeHub();
    let current = first.instance;
    let reviewed = 0;
    const releaseReview = registry.registerReview({
        hook: "400-generation-review",
        id: "generation-review",
        review: () => {
            reviewed += 1;
            return { decision: "continue" };
        },
    });
    const definitions = registry.registerAll([environInfo]);
    const releaseExecute = registry.registerExecute("environ_info", async () => "ok");
    const stop = installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: existingInstances(() => [current]),
    });
    const context = { source: "mcp" } as const;
    try {
        assert.equal(await first.runtime.api.call("local", "environ_info", {}, context), "ok");
        current = second.instance;
        changes.publish();
        await assert.rejects(first.runtime.api.call("local", "environ_info", {}, context), /no execute/iu);
        assert.equal(await second.runtime.api.call("local", "environ_info", {}, context), "ok");
        assert.equal(reviewed, 2);
        stop();
        await assert.rejects(second.runtime.api.call("local", "environ_info", {}, context), /no execute/iu);
        assert.equal(reviewed, 2);
    } finally {
        stop();
        releaseExecute();
        definitions.dispose();
        releaseReview();
        first.runtime.close();
        second.runtime.close();
    }
});

test("global and instance-scoped tools both execute with receiving instance hooks", async () => {
    const registry = createToolCallRegistry();
    const local = catalogSource("local");
    const remote = catalogSource("remote");
    const changes = changeHub();
    const traces: string[] = [];
    const disposeReview = registry.registerReview({
        hook: "400-global-review",
        id: "global-review",
        review: ({ direction, value }) => {
            traces.push(`${value.context.instance}:${direction}:global`);
            return { decision: "continue" };
        },
    });
    const disposeLocalReview = local.runtime.hooks.registerReview({
        hook: "450-local-review",
        id: "local-review",
        review: ({ direction }) => {
            traces.push(`local:${direction}:local`);
            return { decision: "continue" };
        },
    });
    const global = registry.registerAll([environInfo]);
    const scoped = registry.register("local", [bashRun]);
    const disposeGlobalExecute = registry.registerExecute("environ_info", async () => "global");
    const disposeScopedExecute = registry.registerExecute("bash_run", async () => "scoped");
    const stop = installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: existingInstances(() => [local.instance, remote.instance]),
    });
    const context = { requestId: "scope-call", source: "mcp" } as const;
    try {
        assert.deepEqual(local.toolDefinitions.list().map((tool) => tool.name), ["environ_info", "bash_run"]);
        assert.deepEqual(remote.toolDefinitions.list().map((tool) => tool.name), ["environ_info"]);
        assert.equal(await local.runtime.api.call("local", "environ_info", {}, context), "global");
        assert.equal(await local.runtime.api.call("local", "bash_run", {}, context), "scoped");
        assert.equal(await remote.runtime.api.call("remote", "environ_info", {}, context), "global");
        await assert.rejects(remote.runtime.api.call("remote", "bash_run", {}, context), /no execute/iu);
        assert.deepEqual(traces, [
            "local:inbound:global", "local:inbound:local",
            "local:inbound:global", "local:inbound:local",
            "remote:inbound:global", "remote:inbound:global",
        ]);
        scoped.replace([fileRead]);
        assert.deepEqual(local.toolDefinitions.list().map((tool) => tool.name), ["environ_info", "file_read"]);
        await assert.rejects(local.runtime.api.call("local", "bash_run", {}, context), /no execute/iu);
    } finally {
        stop();
        disposeScopedExecute();
        disposeGlobalExecute();
        scoped.dispose();
        global.dispose();
        disposeLocalReview();
        disposeReview();
        local.runtime.close();
        remote.runtime.close();
    }
});

function names(
    registry: ReturnType<typeof createToolCallRegistry>,
    instance: string,
): string[] {
    return registry.list(instance).map((entry) => entry.definition.name);
}

function existingInstances<T>(list: () => readonly T[]) {
    return { list, onAdding: () => () => undefined };
}

function catalogSource(name: string, options: { mcpEnabled?: boolean } = {}) {
    let mcpEnabled = options.mcpEnabled ?? true;
    const toolDefinitions = new TestToolCatalog();
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            dispatch: async (request) => {
                if (request.execute === undefined) throw new Error("no execute registered");
                return (await request.execute(request.callId, request.value.payload, request.value)) as JsonValue;
            },
        }),
    });
    return {
        instance: {
            get config() {
                return { mcpEnabled, name };
            },
            toolCallHooks: runtime.hooks,
            toolDefinitions,
        },
        runtime,
        setMcpEnabled(next: boolean) {
            mcpEnabled = next;
        },
        toolDefinitions,
    };
}

class TestToolCatalog {
    readonly #listeners = new Set<() => void>();
    readonly #registrations = new Map<symbol, Map<string, ToolDefinition>>();

    register(definitions: readonly ToolDefinition[]) {
        const id = Symbol("test-tool-catalog");
        const registration = normalizeDefinitions(definitions);
        this.#assertNoConflicts(registration);
        this.#registrations.set(id, registration);
        this.#notify();
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.#registrations.delete(id);
                this.#notify();
            },
            replace: (next: readonly ToolDefinition[]) => {
                if (disposed) throw new Error("registration disposed");
                const replacement = normalizeDefinitions(next);
                this.#assertNoConflicts(replacement, id);
                this.#registrations.set(id, replacement);
                this.#notify();
            },
        };
    }

    list(): readonly ToolDefinition[] {
        return [...this.#registrations.values()].flatMap((registration) =>
            [...registration.values()],
        );
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #assertNoConflicts(
        candidate: Map<string, ToolDefinition>,
        replacing?: symbol,
    ): void {
        for (const [id, registration] of this.#registrations) {
            if (id === replacing) continue;
            for (const name of candidate.keys()) {
                if (registration.has(name))
                    throw new Error(`Tool ${name} is registered more than once.`);
            }
        }
    }

    #notify(): void {
        for (const listener of [...this.#listeners]) listener();
    }
}

function normalizeDefinitions(
    definitions: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
    return new Map(
        definitions.map((definition) => [
            definition.name,
            structuredClone(definition),
        ]),
    );
}

function changeHub(): {
    onChange(listener: () => void): () => void;
    publish(): void;
} {
    const listeners = new Set<() => void>();
    return {
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        publish: () => {
            for (const listener of [...listeners]) listener();
        },
    };
}

function tool(
    name: string,
    requiredCapabilities: ToolDefinition["requiredCapabilities"] = [],
): ToolDefinition {
    return {
        description: name,
        group: name.slice(0, name.indexOf("_")),
        inputSchema: { type: "object" },
        name,
        outputSchema: { type: "object" },
        requiredCapabilities,
    };
}
