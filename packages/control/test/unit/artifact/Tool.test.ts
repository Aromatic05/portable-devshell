import assert from "node:assert/strict";
import test from "node:test";

import type { InstanceRegistry } from "@portable-devshell/core/instance";
import {
    type ToolCallPresentedResult,
    type ToolCallHooks,
} from "@portable-devshell/core/toolcall";
import { asInstanceName } from "@portable-devshell/shared";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import type { ArtifactImageApi } from "../../../src/artifact/Public.ts";
import { installArtifactTools } from "../../../src/artifact/tool/Runtime.ts";
import { createToolCallRegistry } from "../../../src/toolcall/Public.ts";

function createHooks() {
    const executes = new Map<
        string,
        Parameters<ToolCallHooks["registerExecute"]>[1]
    >();
    const hooks = {
        registerContributor: () => () => undefined,
        registerExecute: (
            name: string,
            execute: Parameters<ToolCallHooks["registerExecute"]>[1],
        ) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview: () => () => undefined,
    } as ToolCallHooks;
    return { executes, hooks };
}

test("Artifact registers image definition for MCP-enabled instance scopes", () => {
    let descriptors = [
        { mcpEnabled: true, name: "local" },
        { mcpEnabled: false, name: "hidden" },
    ];
    const changes = new InstanceChangeHub();
    const instances = {
        list: () => descriptors,
    } as unknown as InstanceRegistry;
    const { hooks } = createHooks();
    const registry = createToolCallRegistry();
    const unbind = registry.bind(hooks);
    const uninstall = installArtifactTools(
        {} as ArtifactImageApi,
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

        descriptors = [{ mcpEnabled: true, name: "remote" }];
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
    const calls: unknown[] = [];
    const artifact = {
        async readImage() {
            throw new Error("unused");
        },
        async viewImage(input: unknown, instance: string) {
            calls.push({ input, instance });
            return {
                blake3: "b".repeat(64),
                bytes: 68,
                content: "png-base64",
                encoding: "base64" as const,
                imageRef: `${"b".repeat(64)}.png`,
                mediaType: "image/png" as const,
                name: "pixel.png",
                source: {
                    instance,
                    path: "./pixel.png",
                    type: "file" as const,
                    workspace: "/repo",
                },
            };
        },
    } as ArtifactImageApi;
    const instances = {
        list: () => [{ mcpEnabled: true, name: "remote" }],
        onChange: () => () => undefined,
    } as unknown as InstanceRegistry;
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
        assert.equal((result as ToolCallPresentedResult).type, "presented-tool-call-result");
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
