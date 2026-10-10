import assert from "node:assert/strict";
import test from "node:test";

import {
    createToolCallRuntime,
    type ArtifactViewImageInput,
    type JsonValue,
    type ToolCallPresentedResult,
} from "@portable-devshell/shared";

import type { ArtifactImageApi } from "../../../src/artifact/Api.ts";
import { installArtifactTools } from "../../../src/artifact/tool/index.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import {
    createToolCallRegistry,
    type InstanceToolCatalogSource,
} from "../../../src/toolcall/index.ts";

interface InstanceEntry {
    config: { mcpEnabled: boolean; name: string };
}

type TestToolCallRuntime = ReturnType<typeof createToolCallRuntime>;

interface TestInstanceCatalog {
    instance: InstanceToolCatalogSource;
    runtime: TestToolCallRuntime;
}

function createRuntime(): TestToolCallRuntime {
    return createToolCallRuntime({
        resolveTarget: () => ({
            dispatch: async (request) => {
                if (request.execute === undefined)
                    throw new Error("no execute registered");
                return (await request.execute(
                    request.callId,
                    request.value.payload,
                    request.value,
                )) as JsonValue;
            },
        }),
    });
}

function createInstances(list: () => readonly InstanceEntry[]): {
    instances: InstanceRegistry;
    runtimeFor(name: string): TestToolCallRuntime;
} {
    const registry = new InstanceRegistry([]);
    const catalogs = new Map<string, TestInstanceCatalog>();
    const source = (entry: InstanceEntry): InstanceToolCatalogSource => {
        const existing = catalogs.get(entry.config.name);
        if (
            existing !== undefined &&
            existing.instance.config.mcpEnabled === entry.config.mcpEnabled
        )
            return existing.instance;
        existing?.runtime.close();
        const runtime = createRuntime();
        catalogs.set(entry.config.name, {
            instance: {
                config: entry.config,
                toolCallHooks: runtime.hooks,
                toolDefinitions: {
                    list: () => [],
                    register: () => ({ dispose() {}, replace() {} }),
                },
            },
            runtime,
        });
        return catalogs.get(entry.config.name)!.instance;
    };
    Object.defineProperty(registry, "list", {
        configurable: true,
        value: () => list().map(source),
    });
    return {
        instances: registry,
        runtimeFor(name: string): TestToolCallRuntime {
            const catalog = catalogs.get(name);
            if (catalog === undefined)
                throw new Error(`No test catalog for instance ${name}.`);
            return catalog.runtime;
        },
    };
}

test("Artifact registers image definition for MCP-enabled instance scopes", () => {
    let descriptors: InstanceEntry[] = [
        { config: { mcpEnabled: true, name: "local" } },
        { config: { mcpEnabled: false, name: "hidden" } },
    ];
    const changes = new InstanceChangeHub();
    const { instances } = createInstances(() => descriptors);
    const registry = createToolCallRegistry();
    const unbind = registry.bind({ changes, instances });
    const uninstall = installArtifactTools(
        unusedArtifact(),
        instances,
        changes,
        registry,
    );
    try {
        assert.equal(
            registry.get("local", "artifact_viewImage")?.definition.name,
            "artifact_viewImage",
        );
        assert.equal(registry.get("hidden", "artifact_viewImage"), undefined);

        descriptors = [{ config: { mcpEnabled: true, name: "remote" } }];
        changes.publish("registry");
        assert.equal(registry.get("local", "artifact_viewImage"), undefined);
        assert.equal(
            registry.get("remote", "artifact_viewImage")?.definition.name,
            "artifact_viewImage",
        );
    } finally {
        uninstall();
        unbind();
    }
    assert.equal(registry.get("remote", "artifact_viewImage"), undefined);
});

test("Artifact execute hook uses ToolCall instance/workspace and presents native image", async () => {
    const calls: Array<{ input: ArtifactViewImageInput; instance: string }> = [];
    const artifact: ArtifactImageApi = {
        async readImage() {
            throw new Error("unused");
        },
        async viewImage(input, instance) {
            calls.push({ input, instance });
            return {
                blake3: "b".repeat(64),
                bytes: 68,
                content: "png-base64",
                encoding: "base64",
                imageRef: `${"b".repeat(64)}.png`,
                mediaType: "image/png",
                name: "pixel.png",
                source: {
                    instance,
                    path: "./pixel.png",
                    type: "file",
                    workspace: "/repo",
                },
            };
        },
    };
    const { instances, runtimeFor } = createInstances(() => [
        { config: { mcpEnabled: true, name: "remote" } },
    ]);
    const registry = createToolCallRegistry();
    const unbind = registry.bind({
        changes: new InstanceChangeHub(),
        instances,
    });
    const uninstall = installArtifactTools(
        artifact,
        instances,
        new InstanceChangeHub(),
        registry,
    );
    try {
        const result = await runtimeFor("remote").api.call(
            "remote",
            "artifact_viewImage",
            { path: "./pixel.png" },
            {
                ctxId: "ctx-1",
                source: "mcp",
                workspace: "/repo",
            },
        );
        const presented = result as unknown as ToolCallPresentedResult;
        assert.equal(presented.type, "presented-tool-call-result");
        assert.deepEqual(calls, [
            {
                input: { path: "./pixel.png", workspace: "/repo" },
                instance: "remote",
            },
        ]);
        assert.deepEqual(presented.presentation.content, [
            { data: "png-base64", mediaType: "image/png", type: "image" },
        ]);
        assert.equal(
            (presented.result as { name?: string }).name,
            "pixel.png",
        );
    } finally {
        uninstall();
        unbind();
    }
});

function unusedArtifact(): ArtifactImageApi {
    return {
        async readImage() {
            throw new Error("unused");
        },
        async viewImage() {
            throw new Error("unused");
        },
    };
}
