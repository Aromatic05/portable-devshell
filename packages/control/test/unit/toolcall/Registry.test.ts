import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@portable-devshell/shared";
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
        instances: { list: () => [source.instance] },
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
        instances: { list: () => sources.map((entry) => entry.instance) },
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
        instances: { list: () => [source.instance] },
    });

    source.toolDefinitions.register([bashRun]);
    assert.deepEqual(names(registry, "local"), []);
});

test("instance catalog bridge follows MCP enablement and preserves conflicts", () => {
    const registry = createToolCallRegistry();
    registry.registerAll([environInfo]);
    const source = catalogSource("local");
    const changes = changeHub();
    installInstanceToolDefinitions({
        changes,
        hooks: registry,
        instances: { list: () => [source.instance] },
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

function names(
    registry: ReturnType<typeof createToolCallRegistry>,
    instance: string,
): string[] {
    return registry.list(instance).map((entry) => entry.definition.name);
}

function catalogSource(name: string, options: { mcpEnabled?: boolean } = {}) {
    let mcpEnabled = options.mcpEnabled ?? true;
    const toolDefinitions = new TestToolCatalog();
    return {
        instance: {
            get config() {
                return { mcpEnabled, name };
            },
            toolDefinitions,
        },
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
