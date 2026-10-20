import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./persistence/CrashProcess.ts";

const storeModule = new URL("../../../../src/config/store/index.ts", import.meta.url).href;
const independentRead = `
const { ControlConfigStore } = await import(${JSON.stringify(storeModule)});
process.stdout.write(JSON.stringify(await new ControlConfigStore().readOrCreate(JSON.parse(process.argv[1]))));
`;

async function initialGeneration(home: string) {
    const config = createDefaultControlConfig();
    config.web.listenPort = 17930;
    config.instances = ["alpha-local", "beta-local"].map((name) =>
        normalizeConfigInstanceDraft({ name, provider: "local", enabled: name === "alpha-local" }),
    );
    await new ControlConfigStore().write(config, home);
    return config;
}

for (const [label, manifest] of [
    ["invalid JSON", "{"],
    ["unsafe instance path", JSON.stringify({ existingGlobal: true, existingInstances: ["../escape.toml"], nextInstances: [] })],
    ["wrong global-presence type", JSON.stringify({ existingGlobal: "yes", existingInstances: [], nextInstances: [] })],
    ["non-string instance entry", JSON.stringify({ existingGlobal: true, existingInstances: [4], nextInstances: [] })],
] as const) {
    test(`restart refuses a transaction manifest with ${label} without changing live config`, async (t) => {
        const home = await createTestTempDirectory("round6-manifest");
        t.after(() => rm(home, { recursive: true, force: true }));
        const paths = new ControlPathHome(home);
        await initialGeneration(home);
        const before = await readFile(paths.configFile, "utf8");
        const id = "12345678-1234-1234-1234-123456789abc";
        const journal = join(paths.controlHomeDir, `.config-transaction-${id}`);
        await mkdir(journal, { recursive: true });
        await writeFile(join(journal, "manifest.json"), manifest);
        await writeFile(join(paths.controlHomeDir, ".config-transaction"), id);

        await assert.rejects(new ControlConfigStore().readOrCreate(home), (error: unknown) => {
            assert.equal((error as { code?: string }).code, "control.configLoadFailed");
            assert.equal((error as { details?: { phase?: string } }).details?.phase, "recover");
            return true;
        });
        assert.equal(await readFile(paths.configFile, "utf8"), before);
        assert.equal(await readFile(join(paths.controlHomeDir, ".config-transaction"), "utf8"), id);
    });
}

test("full multi-instance TOML generation survives a fresh store process", async (t) => {
    const home = await createTestTempDirectory("round6-toml-generation");
    t.after(() => rm(home, { recursive: true, force: true }));
    const config = createDefaultControlConfig();
    config.web.listenPort = 17931;
    config.web.enabled = true;
    config.instances = [
        normalizeConfigInstanceDraft({ name: "one-local", provider: "local", enabled: false, mcp: { contextMode: "openai-session" } }),
        normalizeConfigInstanceDraft({ name: "two-local", provider: "local", enabled: true, workspace: { enabled: false } }),
    ];
    await new ControlConfigStore().write(config, home);

    const restarted = JSON.parse(runPersistenceProcess(independentRead, home));
    assert.equal(restarted.web.listenPort, 17931);
    assert.equal(restarted.web.enabled, true);
    assert.deepEqual(restarted.instances.map((entry: { name: string; enabled: boolean }) => [entry.name, entry.enabled]), [
        ["one-local", false], ["two-local", true],
    ]);
    assert.equal(restarted.instances[0].mcp.contextMode, "openai-session");
    assert.equal(restarted.instances[1].workspace.enabled, false);
});

test("malformed unrelated TOML and non-TOML files remain byte-identical across an update and restart", async (t) => {
    const home = await createTestTempDirectory("round6-unrelated-files");
    t.after(() => rm(home, { recursive: true, force: true }));
    const paths = new ControlPathHome(home);
    const config = await initialGeneration(home);
    const malformed = join(paths.instancesDir, "operator-owned.toml");
    const notes = join(paths.instancesDir, "operator-owned.txt");
    await writeFile(malformed, "this = [not valid TOML\n");
    await writeFile(notes, "retained notes\n");
    const warning = t.mock.method(console, "warn", () => undefined);

    const loaded = await new ControlConfigStore().readOrCreate(home);
    assert.deepEqual(loaded.instances.map((entry) => entry.name), ["alpha-local", "beta-local"]);
    config.web.listenPort = 17932;
    await new ControlConfigStore().write({ ...config, web: { ...config.web, listenPort: 17932 } }, home);
    assert.equal(await readFile(malformed, "utf8"), "this = [not valid TOML\n");
    assert.equal(await readFile(notes, "utf8"), "retained notes\n");
    assert.equal(warning.mock.callCount(), 2);
    assert.equal(JSON.parse(runPersistenceProcess(independentRead, home)).web.listenPort, 17932);
    assert.deepEqual((await readdir(paths.instancesDir)).sort(), ["alpha-local.toml", "beta-local.toml", "operator-owned.toml", "operator-owned.txt"]);
});

const faultCases = [
    { label: "global rename EIO", target: "global", operation: "rename", code: "EIO" },
    { label: "global file sync EIO", target: "global", operation: "sync", code: "EIO" },
    { label: "second instance write ENOSPC", target: "beta", operation: "writeFile", code: "ENOSPC" },
    { label: "second instance rename ENOSPC", target: "beta", operation: "rename", code: "ENOSPC" },
] as const;

for (const fault of faultCases) {
    test(`failed ${fault.label} rolls back the complete multi-instance generation after restart`, async (t) => {
        const home = await createTestTempDirectory("round6-write-failure");
        t.after(() => rm(home, { recursive: true, force: true }));
        const paths = new ControlPathHome(home);
        const original = await initialGeneration(home);
        const previousPaths = [paths.configFile, ...original.instances.map((entry) => paths.instanceConfigFile(entry.name))];
        const previousBytes = await Promise.all(previousPaths.map((path) => readFile(path, "utf8")));
        const next = structuredClone(original);
        next.web.listenPort = 17939;
        next.instances[0]!.enabled = true;
        next.instances[1]!.enabled = false;
        const processSource = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const { home, next, fault } = JSON.parse(process.argv[1]);
let hits = 0;
const globalTarget = ${JSON.stringify(paths.configFile)};
const instanceTarget = ${JSON.stringify(paths.instanceConfigFile("beta-local"))};
const target = fault.target === 'global' ? globalTarget : instanceTarget;
if (fault.operation === 'rename') {
    const rename = fs.rename;
    fs.rename = async (...args) => {
        if (hits === 0 && args[1] === target && String(args[0]).includes('.tmp-')) {
            hits++;
            throw Object.assign(new Error('injected rename fault'), { code: fault.code });
        }
        return await rename(...args);
    };
} else {
    const open = fs.open;
    fs.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(target + '.tmp-')) {
            const original = handle[fault.operation].bind(handle);
            handle[fault.operation] = async (...values) => {
                if (hits === 0) {
                    hits++;
                    throw Object.assign(new Error('injected file fault'), { code: fault.code });
                }
                return await original(...values);
            };
        }
        return handle;
    };
}
syncBuiltinESMExports();
const { ControlConfigStore } = await import(${JSON.stringify(storeModule)});
await assert.rejects(new ControlConfigStore().write(next, home));
assert.equal(hits, 1);
process.stdout.write('fault observed');
`;
        assert.equal(runPersistenceProcess(processSource, { home, next, fault }), "fault observed");
        const restarted = JSON.parse(runPersistenceProcess(independentRead, home));
        assert.equal(restarted.web.listenPort, original.web.listenPort);
        assert.deepEqual(restarted.instances.map((entry: { name: string; enabled: boolean }) => [entry.name, entry.enabled]), [
            ["alpha-local", true], ["beta-local", false],
        ]);
        assert.deepEqual(await Promise.all(previousPaths.map((path) => readFile(path, "utf8"))), previousBytes);
        await assert.rejects(readFile(join(paths.controlHomeDir, ".config-transaction")), { code: "ENOENT" });
    });
}
