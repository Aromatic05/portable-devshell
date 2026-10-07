import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ArtifactViewImageInput,
    type ToolCallExecutor,
    type ToolCallHooks,
    type ToolCallPresentedResult,
} from "@portable-devshell/shared";

import type { ArtifactImageApi } from "../../../src/artifact/Api.ts";
import { installArtifactTools } from "../../../src/artifact/tool/index.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { createToolCallRegistry } from "../../../src/toolcall/index.ts";

interface InstanceEntry {
    config: { mcpEnabled: boolean; name: string };
}

function createHooks() {
    const executes = new Map<string, ToolCallExecutor>();
    const hooks: ToolCallHooks = {
        registerContributor: () => () => undefined,
        registerExecute: (name, execute) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview: () => () => undefined,
    };
    return { executes, hooks };
}

function createInstances(
    list: () => readonly InstanceEntry[],
): InstanceRegistry {
    const registry = new InstanceRegistry([]);
    Object.defineProperty(registry, "list", {
        configurable: true,
        value: list,
    });
    return registry;
}

test("Artifact registers image definition for MCP-enabled instance scopes", () => {
    let descriptors: InstanceEntry[] = [
        { config: { mcpEnabled: true, name: "local" } },
        { config: { mcpEnabled: false, name: "hidden" } },
    ];
    const changes = new InstanceChangeHub();
    const instances = createInstances(() => descriptors);
    const { hooks } = createHooks();
    const registry = createToolCallRegistry();
    const unbind = registry.bind(hooks);
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
    const instances = createInstances(() => [
        { config: { mcpEnabled: true, name: "remote" } },
    ]);
    const { executes, hooks } = createHooks();
    const registry = createToolCallRegistry();
    const unbind = registry.bind(hooks);
    const uninstall = installArtifactTools(
        artifact,
        instances,
        new InstanceChangeHub(),
        registry,
    );
    try {
        const execute = executes.get("artifact_viewImage");
        assert.ok(execute);
        const result = await execute(
            "call-1",
            { path: "./pixel.png" },
            {
                context: {
                    ctxId: "ctx-1",
                    instance: asInstanceName("remote"),
                    source: "mcp",
                    workspace: "/repo",
                },
                kind: "call",
                payload: { path: "./pixel.png" },
                toolName: "artifact_viewImage",
            },
        );
        assert.equal(
            (result as ToolCallPresentedResult).type,
            "presented-tool-call-result",
        );
        const presented = result as ToolCallPresentedResult;
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
