import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig
} from "@portable-devshell/shared";
import type { HttpHost } from "@portable-devshell/mcp";
import {
    ControlRuntimeReverse,
    InstanceRegistryFactory
} from "../../src/testing.ts";
import type { ControlRuntimeMcp } from "../../src/composition/runtime/ControlRuntimeMcp.ts";
import type { ControlRuntimeState } from "../../src/composition/runtime/ControlRuntimeState.ts";

class RecordingHttpHost {
    readonly rawPaths: string[] = [];
    readonly upgradePaths: string[] = [];

    registerRawRoute(_method: string, path: string): () => void {
        this.rawPaths.push(path);
        return () => undefined;
    }

    registerUpgradeHandler(path: string): () => void {
        this.upgradePaths.push(path);
        return () => undefined;
    }
}

test("reverse runtime adopts a changed MCP public URL on the replacement host", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-reverse-runtime-"));
    t.after(async () => await rm(homeDirectory, { force: true, recursive: true }));
    const config = reverseConfig("https://controller.example.test/old");
    const instances = new InstanceRegistryFactory().build(config);
    const firstHost = new RecordingHttpHost();
    const state = {
        homeDirectory,
        instances,
        requireConfig: () => config
    } as unknown as ControlRuntimeState;
    const mcp = {
        host: { server: firstHost as unknown as HttpHost }
    } as unknown as ControlRuntimeMcp;
    const reverse = new ControlRuntimeReverse({ mcp, state });

    assert.equal(firstHost.rawPaths.includes("/old/reverse/v1/enroll"), true);
    const nextHost = new RecordingHttpHost();
    reverse.install(
        nextHost as unknown as HttpHost,
        "https://controller.example.test/new"
    );

    assert.equal(nextHost.rawPaths.includes("/new/reverse/v1/enroll"), true);
    assert.equal(nextHost.upgradePaths.includes("/new/reverse/v1/connect"), true);
    const code = await reverse.service!.createDeviceCode("reverse-worker");
    assert.equal(code.controllerUrl, "https://controller.example.test/new");
});

function reverseConfig(publicBaseUrl: string): ControlConfig {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.mcp.publicBaseUrl = publicBaseUrl;
    config.instances = [normalizeConfigInstanceDraft({
        name: "reverse-worker",
        provider: "reverse",
        workspace: "/workspace/reverse-worker"
    })];
    return config;
}
