import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import type { ExtensionConfigDeclaration } from "@portable-devshell/extension";
import { createDefaultControlConfig } from "@portable-devshell/shared";

import { ConfigChangeHub } from "../../../../../src/config/Change.ts";
import { ControlConfigMutationLock } from "../../../../../src/config/editor/Lock.ts";
import { createCoreConfigRegistry } from "../../../../../src/config/Registry.ts";
import {
    ExtensionConfigControl,
    extensionConfigDomainDefinition,
} from "../../../../../src/extension/config/Control.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

const ownedDeclaration: ExtensionConfigDeclaration = {
    default: {
        enabled: false,
        nested: { count: 1 },
    },
    schema: {
        additionalProperties: false,
        properties: {
            enabled: { type: "boolean" },
            nested: {
                additionalProperties: false,
                properties: { count: { type: "number" } },
                required: ["count"],
                type: "object",
            },
        },
        required: ["enabled", "nested"],
        type: "object",
    },
};

const noopCoreUpdate = async (): Promise<void> => undefined;

test("Extension Config owns one schema-backed domain, emits committed paths, and fences stale generation writes", async () => {
    const stateDirectory = await createTestTempDirectory(
        "extension-config-owned",
    );
    const registry = createCoreConfigRegistry();
    const firstDefinition = extensionConfigDomainDefinition(
        "example",
        "gen-a",
        ownedDeclaration,
    );
    assert.ok(firstDefinition);
    registry.register(firstDefinition);
    const changeHub = new ConfigChangeHub();
    const mutationRunner = new ControlConfigMutationLock();
    const coreConfig = createDefaultControlConfig();
    const first = new ExtensionConfigControl({
        changeHub,
        declaration: ownedDeclaration,
        extensionId: "example",
        generation: "gen-a",
        mutationRunner,
        readCoreConfig: () => coreConfig,
        registry,
        stateDirectory,
        updateCoreConfig: noopCoreUpdate,
    });
    const firstOwned = first.owned!;
    const firstChanges: string[][] = [];
    firstOwned.onChange((change) => firstChanges.push([...change.paths]));

    try {
        await first.validate();
        assert.equal(await firstOwned.get("example.enabled"), false);
        assert.equal(await firstOwned.get("example.nested.count"), 1);

        await firstOwned.update({
            "example.enabled": true,
            "example.nested.count": 2,
        });
        assert.equal(await firstOwned.get("example.enabled"), true);
        assert.equal(await firstOwned.get("example.nested.count"), 2);
        assert.deepEqual(firstChanges, [
            ["example.enabled", "example.nested.count"],
        ]);

        await assert.rejects(
            async () =>
                await firstOwned.update({
                    "example.nested.count": "invalid",
                }),
            /does not match/u,
        );

        const secondDefinition = extensionConfigDomainDefinition(
            "example",
            "gen-b",
            ownedDeclaration,
        );
        assert.ok(secondDefinition);
        registry.replace(secondDefinition);
        const second = new ExtensionConfigControl({
            changeHub,
            declaration: ownedDeclaration,
            extensionId: "example",
            generation: "gen-b",
            mutationRunner,
            readCoreConfig: () => coreConfig,
            registry,
            stateDirectory,
            updateCoreConfig: noopCoreUpdate,
        });
        const secondOwned = second.owned!;
        try {
            await second.validate();
            await secondOwned.update({ "example.nested.count": 3 });
            assert.equal(await firstOwned.get("example.nested.count"), 3);
            await assert.rejects(
                async () =>
                    await firstOwned.update({ "example.nested.count": 4 }),
                /not writable by this generation/u,
            );
        } finally {
            second.close();
        }
    } finally {
        first.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});

test("Extension Config reads only explicitly requested Core exports and filters change delivery", async () => {
    const stateDirectory = await createTestTempDirectory(
        "extension-config-access",
    );
    const registry = createCoreConfigRegistry();
    const changeHub = new ConfigChangeHub();
    const coreConfig = createDefaultControlConfig();
    const config = new ExtensionConfigControl({
        changeHub,
        declaration: {
            coreAccess: {
                "mcp.listenPort": "read",
            },
        },
        extensionId: "observer",
        generation: "gen-a",
        mutationRunner: new ControlConfigMutationLock(),
        readCoreConfig: () => coreConfig,
        registry,
        stateDirectory,
        updateCoreConfig: noopCoreUpdate,
    });
    assert.equal(config.owned, undefined);
    const core = config.core!;
    const changes: string[][] = [];
    core.onChange((change) => changes.push([...change.paths]));

    try {
        await config.validate();
        assert.equal(
            await core.get("mcp.listenPort"),
            coreConfig.mcp.listenPort,
        );
        await assert.rejects(
            async () => await core.get("mcp.listenHost"),
            /not authorized/u,
        );
        await assert.rejects(
            async () => await core.update({ "observer.enabled": true }),
            /not authorized/u,
        );

        changeHub.publish(["mcp.listenHost", "mcp.listenPort"]);
        assert.deepEqual(changes, [["mcp.listenPort"]]);

        const unexported = new ExtensionConfigControl({
            changeHub,
            declaration: { coreAccess: { "web.auth": "read" } },
            extensionId: "unexported",
            generation: "gen-a",
            mutationRunner: new ControlConfigMutationLock(),
            readCoreConfig: () => coreConfig,
            registry,
            stateDirectory,
            updateCoreConfig: noopCoreUpdate,
        });
        try {
            await assert.rejects(
                async () => await unexported.validate(),
                /does not export requested read access/u,
            );
        } finally {
            unexported.close();
        }

        const excessive = new ExtensionConfigControl({
            changeHub,
            declaration: { coreAccess: { "mcp.listenPort": "read-write" } },
            extensionId: "excessive",
            generation: "gen-a",
            mutationRunner: new ControlConfigMutationLock(),
            readCoreConfig: () => coreConfig,
            registry,
            stateDirectory,
            updateCoreConfig: noopCoreUpdate,
        });
        try {
            await assert.rejects(
                async () => await excessive.validate(),
                /does not export requested read-write access/u,
            );
        } finally {
            excessive.close();
        }
    } finally {
        config.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});

test("Extension Config writes only explicitly requested read-write Core exports", async () => {
    const stateDirectory = await createTestTempDirectory(
        "extension-config-core-write",
    );
    const registry = createCoreConfigRegistry();
    const changeHub = new ConfigChangeHub();
    let coreConfig = createDefaultControlConfig();
    const writes: Readonly<Record<string, unknown>>[] = [];
    const config = new ExtensionConfigControl({
        changeHub,
        declaration: {
            coreAccess: {
                "mcp.publicBaseUrl": "read-write",
            },
        },
        extensionId: "publisher",
        generation: "gen-a",
        mutationRunner: new ControlConfigMutationLock(),
        readCoreConfig: () => coreConfig,
        registry,
        stateDirectory,
        updateCoreConfig: async (patch) => {
            writes.push(structuredClone(patch));
            coreConfig = {
                ...coreConfig,
                mcp: {
                    ...coreConfig.mcp,
                    publicBaseUrl: patch["mcp.publicBaseUrl"] as string,
                },
            };
            changeHub.publish(Object.keys(patch));
        },
    });
    const core = config.core!;
    const changes: string[][] = [];
    core.onChange((change) => changes.push([...change.paths]));

    try {
        await config.validate();
        await core.update({
            "mcp.publicBaseUrl": "https://public.example.test/mcp",
        });
        assert.deepEqual(writes, [
            {
                "mcp.publicBaseUrl": "https://public.example.test/mcp",
            },
        ]);
        assert.equal(
            await core.get("mcp.publicBaseUrl"),
            "https://public.example.test/mcp",
        );
        assert.deepEqual(changes, [["mcp.publicBaseUrl"]]);
        await assert.rejects(
            async () => await core.update({ "mcp.listenPort": 19000 }),
            /not authorized/u,
        );
    } finally {
        config.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
