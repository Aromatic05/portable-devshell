import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
    CONTROL_PROTOCOL_RANGE,
    ControlPathHome,
} from "@portable-devshell/shared";
import { FRAME_PROTOCOL_RANGE } from "@portable-devshell/shared/transport/frame";
import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
} from "@portable-devshell/extension";

import { preflightControlUpdate } from "../../../../../src/migration/Control.ts";
import { ExtensionPathLayout } from "../../../../../src/control/extension/state/Layout.ts";
import { ExtensionRegistryStore } from "../../../../../src/control/extension/state/Store.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

test("Extension state follows PORTABLE_DEVSHELL_HOME", () => {
    const devshellHome = join("custom", "devshell-home");
    const paths = new ExtensionPathLayout({
        environment: { PORTABLE_DEVSHELL_HOME: devshellHome },
    });
    assert.equal(
        paths.stateRoot,
        join(devshellHome, "control", "extensions"),
    );
});

test("Extension registry persists selected and last-known-good generations atomically", async (t) => {
    const root = await createTestTempDirectory("extension-registry");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });
    const store = new ExtensionRegistryStore(paths.registryFile);

    assert.deepEqual(await store.read(), { extensions: {}, schemaVersion: 1 });
    await store.write({
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next",
            },
        },
        schemaVersion: 1,
    });

    assert.deepEqual(await store.read(), {
        extensions: {
            agent: {
                enabled: true,
                lastKnownGoodGeneration: "0.1.0-good",
                selectedGeneration: "0.2.0-next",
            },
        },
        schemaVersion: 1,
    });
    const source = await readFile(paths.registryFile, "utf8");
    assert.match(source, /"lastKnownGoodGeneration": "0\.1\.0-good"/u);
});

test("update preflight validates referenced installed Extension generations before mutation", async (t) => {
    const root = await createTestTempDirectory("extension-update-preflight");
    const homeDirectory = join(root, "home");
    const dataHome = join(root, "data");
    const paths = new ExtensionPathLayout({
        dataHome,
        homeDirectory,
        runtimeRoot: join(root, "runtime"),
    });
    const store = new ExtensionRegistryStore(paths.registryFile);
    const id = "example";
    const generation = "1.0.0-test";
    await mkdir(paths.generationDirectory(id, generation), { recursive: true });
    const manifest = (range: string) => ({
        activation: "lazy",
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        extensions: {},
        hostDependencies: { "@modelcontextprotocol/client": range },
        id,
        name: "Example",
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        version: "1.0.0",
    });
    await writeFile(
        paths.manifestFile(id, generation),
        `${JSON.stringify(manifest("^2.0.0"))}\n`,
        "utf8",
    );
    await store.write({
        extensions: {
            [id]: {
                enabled: true,
                lastKnownGoodGeneration: generation,
                selectedGeneration: generation,
            },
        },
        schemaVersion: 1,
    });
    t.after(async () => await rm(root, { force: true, recursive: true }));

    assert.deepEqual(
        await preflightControlUpdate({
            environment: { ...process.env, XDG_DATA_HOME: dataHome },
            homeDirectory,
        }),
        {
            extensions: { checkedGenerations: 1 },
            migration: { domains: [], required: false },
            protocols: {
                control: {
                    candidate: CONTROL_PROTOCOL_RANGE,
                    compatible: true,
                    current: null,
                },
                frame: {
                    candidate: FRAME_PROTOCOL_RANGE,
                    compatible: true,
                    current: null,
                },
                worker: {
                    candidate: { max: "1.0.0", min: "1.0.0" },
                    compatible: true,
                    current: null,
                },
            },
            rollback: { blockers: [], feasible: true },
        },
    );

    await writeFile(
        paths.manifestFile(id, generation),
        `${JSON.stringify(manifest("^3.0.0"))}\n`,
        "utf8",
    );
    await assert.rejects(async () =>
        preflightControlUpdate({
            environment: { ...process.env, XDG_DATA_HOME: dataHome },
            homeDirectory,
        }),
    );
});

test("update preflight validates current Control Worker and Frame protocol ranges", async (t) => {
    const root = await createTestTempDirectory("protocol-update-preflight");
    const homeDirectory = join(root, "home");
    const currentApplicationDirectory = join(root, "current");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await writeCurrentProtocolModules(currentApplicationDirectory, {
        control: 1,
        frame: 1,
        worker: "1.0.0",
    });

    const result = await preflightControlUpdate({
        currentApplicationDirectory,
        homeDirectory,
    });
    assert.deepEqual(result.protocols, {
        control: {
            candidate: CONTROL_PROTOCOL_RANGE,
            compatible: true,
            current: { max: "1.0.0", min: "1.0.0" },
        },
        frame: {
            candidate: FRAME_PROTOCOL_RANGE,
            compatible: true,
            current: { max: "1.0.0", min: "1.0.0" },
        },
        worker: {
            candidate: { max: "1.0.0", min: "1.0.0" },
            compatible: true,
            current: { max: "1.0.0", min: "1.0.0" },
        },
    });
});

test("update preflight rejects a current protocol generation outside the candidate range", async (t) => {
    const root = await createTestTempDirectory("protocol-update-reject");
    const homeDirectory = join(root, "home");
    const currentApplicationDirectory = join(root, "current");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await writeCurrentProtocolModules(currentApplicationDirectory, {
        control: "2.0.0",
        frame: "1.0.0",
        worker: "1.0.0",
    });

    await assert.rejects(() =>
        preflightControlUpdate({
            currentApplicationDirectory,
            homeDirectory,
        }),
    );
});

test("update preflight rejects unsafe semantic protocol components", async (t) => {
    const root = await createTestTempDirectory("protocol-update-unsafe");
    const homeDirectory = join(root, "home");
    const currentApplicationDirectory = join(root, "current");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await writeCurrentProtocolModules(currentApplicationDirectory, {
        control: "1.0.0",
        frame: "1.0.0",
        worker: "1.0.0",
    });
    await writeFile(
        join(
            currentApplicationDirectory,
            "node_modules",
            "@portable-devshell",
            "shared",
            "dist",
            "protocol",
            "control",
            "ControlProtocol.js",
        ),
        'export const CONTROL_PROTOCOL_RANGE = { min: "1.0.0", max: "9007199254740993.0.0" };\n',
        "utf8",
    );

    await assert.rejects(() =>
        preflightControlUpdate({
            currentApplicationDirectory,
            homeDirectory,
        }),
    );
});

test("update preflight reports persistent migration as a rollback blocker", async (t) => {
    const root = await createTestTempDirectory("rollback-update-preflight");
    const homeDirectory = join(root, "home");
    const paths = new ControlPathHome(homeDirectory);
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(paths.controlHomeDir, { recursive: true });
    await writeFile(
        paths.configFile,
        [
            "version = 1",
            "[control]",
            'logLevel = "info"',
            "[mcp]",
            "enabled = true",
            'listenHost = "127.0.0.1"',
            "listenPort = 17890",
            "[web]",
            "enabled = true",
        ].join("\n"),
        "utf8",
    );

    const result = await preflightControlUpdate({ homeDirectory });
    assert.deepEqual(result.migration, {
        domains: ["config"],
        required: true,
    });
    assert.deepEqual(result.rollback, {
        blockers: ["persistentMigrationRequired"],
        feasible: false,
    });
});

async function writeCurrentProtocolModules(
    applicationDirectory: string,
    versions: {
        control: number | string;
        frame: number | string;
        worker: number | string;
    },
): Promise<void> {
    const shared = join(
        applicationDirectory,
        "node_modules",
        "@portable-devshell",
        "shared",
        "dist",
    );
    const core = join(
        applicationDirectory,
        "node_modules",
        "@portable-devshell",
        "core",
        "dist",
    );
    const controlModule = join(shared, "protocol", "control", "ControlProtocol.js");
    const frameModule = join(shared, "transport", "frame", "Codec.js");
    const workerModule = join(core, "worker", "protocol", "Client.js");
    await mkdir(dirname(controlModule), { recursive: true });
    await mkdir(dirname(frameModule), { recursive: true });
    await mkdir(dirname(workerModule), { recursive: true });
    await writeFile(
        join(shared, "..", "package.json"),
        '{"type":"module"}\n',
        "utf8",
    );
    await writeFile(
        join(core, "..", "package.json"),
        '{"type":"module"}\n',
        "utf8",
    );
    await writeFile(
        controlModule,
        `export const CONTROL_PROTOCOL_VERSION = ${JSON.stringify(versions.control)};\n`,
        "utf8",
    );
    await writeFile(
        frameModule,
        `export const FRAME_PROTOCOL_VERSION = ${JSON.stringify(versions.frame)};\n`,
        "utf8",
    );
    await writeFile(
        workerModule,
        `export const WORKER_PROTOCOL_VERSION = ${JSON.stringify(versions.worker)};\n`,
        "utf8",
    );
}

test("Extension path layout separates immutable code, persistent data, mutable state and runtime directories", async (t) => {
    const root = await createTestTempDirectory("extension-path-layout");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "xdg-data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });

    assert.equal(
        paths.generationDirectory("agent", "0.1.0-hash"),
        join(
            root,
            "xdg-data",
            "portable-devshell",
            "extensions",
            "agent",
            "0.1.0-hash",
        ),
    );
    assert.equal(
        paths.dataDirectory("agent"),
        join(root, "xdg-data", "portable-devshell", "extension-data", "agent"),
    );
    assert.equal(
        paths.stateDirectory("agent"),
        join(
            root,
            "home",
            ".devshell",
            "control",
            "extensions",
            "state",
            "agent",
        ),
    );
    assert.equal(
        paths.runtimeDirectory("agent", "0.1.0-hash"),
        join(root, "runtime", "agent", "0.1.0-hash"),
    );
    assert.throws(
        () => paths.generationDirectory("../escape", "g1"),
        /Invalid Extension id/u,
    );
    assert.throws(
        () => paths.runtimeDirectory("agent", "../escape"),
        /Invalid Extension generation/u,
    );
});
