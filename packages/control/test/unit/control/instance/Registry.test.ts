import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistry, createInstance } from "@portable-devshell/core/instance";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContextTransport } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { ControlRuntimeFactory } from "../../../../src/server/runtime/Factory.ts";
import { ControlRuntimeState } from "../../../../src/server/runtime/State.ts";
import { McpEndpointFactory } from "../../../../src/server/mcp/Endpoint.ts";
import { McpRuntimeFactory } from "../../../../src/server/mcp/Runtime.ts";
import { McpRuntimeState } from "@portable-devshell/mcp";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";

test("disabled instances are skipped and registry does not auto start workers", () => {
    const config = createDefaultControlConfig();

    config.instances.push(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
        normalizeConfigInstanceDraft({
            enabled: false,
            mcp: { enabled: true },
            name: "demo-disabled",
            provider: "local",
        }),
    );
    config.mcp.enabled = true;

    const registry = new InstanceRegistry(config.instances.filter(instance => instance.enabled).map(instance => createInstance(instance, { events: { cursor: () => 0, append: async () => { throw new Error("No event append expected before start."); }, readFrom: () => ({ kind: "events", events: [], lastSeq: 0 }) } })));

    assert.equal(registry.list().length, 1);
    assert.equal(registry.get("demo-disabled"), undefined);
    assert.equal(registry.get("demo-local")?.worker.snapshot().ready, false);
});

test("mcp endpoint path is generated and wiring only builds host configuration", () => {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances.push(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
    );

    const registry = new InstanceRegistry(config.instances.filter(instance => instance.enabled).map(instance => createInstance(instance, { events: { cursor: () => 0, append: async () => { throw new Error("No event append expected before start."); }, readFrom: () => ({ kind: "events", events: [], lastSeq: 0 }) } })));
    const descriptor = registry.get("demo-local");

    assert.ok(descriptor !== undefined);
    assert.equal(descriptor.mcpPath, "/demo-local/mcp");
    const endpoint = new McpEndpointFactory().map(descriptor);
    assert.deepEqual(endpoint.auth, { enabled: false, provider: "none" });
    assert.equal(endpoint.contextMode, descriptor.mcpContextMode);
    assert.equal(endpoint.name, "demo-local");
    assert.equal(endpoint.path, "/demo-local/mcp");
    assert.deepEqual(endpoint.worker.snapshot(), descriptor.worker.snapshot());
    assert.equal(endpoint.workspaceEnabled, true);

    const host = new McpRuntimeFactory().wire(config, registry, {
        runtimeState: new McpRuntimeState({
            context: { resolve: async () => { throw new Error("No Context operation expected before host start."); } } as unknown as ContextTransport,
            tools: { async call() { throw new Error("No tool call expected before host start."); } },
        }),
    });

    assert.ok(host !== undefined);
    assert.ok(host.server);
    assert.equal(descriptor.worker.snapshot().ready, false);
});

test("MCP runtime is absent while global MCP remains disabled", () => {
    const config = createDefaultControlConfig();
    config.mcp.enabled = false;
    config.web.enabled = true;
    config.instances.push(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
    );
    const registry = new InstanceRegistry(config.instances.filter(instance => instance.enabled).map(instance => createInstance(instance, { events: { cursor: () => 0, append: async () => { throw new Error("No event append expected before start."); }, readFrom: () => ({ kind: "events", events: [], lastSeq: 0 }) } })));
    const mapped: string[] = [];
    const factory = new McpRuntimeFactory({
        mapper: {
            map(descriptor: Parameters<McpEndpointFactory["map"]>[0]) {
                mapped.push(descriptor.name);
                return new McpEndpointFactory().map(descriptor);
            },
        } as never,
    });

    const host = factory.wire(config, registry);

    assert.equal(host, undefined);
    assert.deepEqual(mapped, []);
});

test("runtime stops only owned workers and retains ownership after a failed stop", async (t) => {
    const directory = await createTestTempDirectory("runtime-owned-workers");
    const state = new ControlRuntimeState({ homeDirectory: directory });
    const config = createDefaultControlConfig();
    config.mcp.enabled = false;
    config.web.enabled = false;
    const stopped: string[] = [];
    let failStop = true;
    const createOwnedCandidate = (name: string) => {
        const definition = normalizeConfigInstanceDraft({ name, provider: "local" });
        config.instances.push(definition);
        const instance = state.instanceRuntimes.create(definition);
        state.instances.add(instance);
        instance.worker.stop = async () => {
            stopped.push(name);
            if (name === "owned-fail" && failStop) throw new Error("stop failed");
            return instance.worker.snapshot();
        };
        return instance;
    };
    const ownedOk = createOwnedCandidate("owned-ok");
    const ownedFail = createOwnedCandidate("owned-fail");
    createOwnedCandidate("unowned");
    state.setConfig(config);
    ownedOk.markOwned();
    ownedFail.markOwned();
    const runtime = await new ControlRuntimeFactory({ builtinExtensionSources: [] }).create({
        restart: async () => {}, shutdown: async () => {}, socketPath: join(directory, "control.sock"), state,
    });
    t.after(async () => {
        failStop = false;
        await runtime.stop();
        await rm(directory, { force: true, recursive: true });
    });
    await assert.rejects(runtime.stop(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.some(failure => failure instanceof AggregateError && /Failed to stop 1 worker/u.test(failure.message)));
        return true;
    });
    assert.deepEqual(stopped, ["owned-ok", "owned-fail"]);
    assert.deepEqual(ownedOk.ownedWorkers(), []);
    assert.deepEqual(ownedFail.ownedWorkers(), [ownedFail.worker]);
    stopped.length = 0;
    await assert.rejects(runtime.stop(), /Control runtime failed to stop cleanly/u);
    assert.deepEqual(stopped, ["owned-fail"]);
});
