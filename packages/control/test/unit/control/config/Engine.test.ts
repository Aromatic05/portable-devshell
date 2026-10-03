import assert from "node:assert/strict";
import test from "node:test";

import {
    controlErrorCodes,
    type ControlConfig,
} from "@portable-devshell/shared";
import { ConfigEngine } from "../../../../src/config/Engine.ts";
import { ConfigChangeHub } from "../../../../src/config/Change.ts";
import { createDefaultControlConfig } from "../../../../src/testing.ts";

const runtimeChanges = { instanceAuth: false, mcp: false, web: true };

function nextConfig(previous: ControlConfig): ControlConfig {
    return {
        ...structuredClone(previous),
        web: { ...previous.web, listenPort: previous.web.listenPort + 1 },
    };
}

test("commit validation and preflight failures do not persist or publish", async () => {
    const initial = createDefaultControlConfig();
    let current = initial;
    let writes = 0;
    const hub = new ConfigChangeHub();
    let preflightCalls = 0;
    let runtimeCalls = 0;
    const preflightFailure = new Error("occupied");
    const engine = new ConfigEngine({
        changeHub: hub,
        configStore: { async write() { writes += 1; } },
        getConfig: () => current,
        runtimeApply: { async apply() { runtimeCalls += 1; return true; } },
        runtimePreflight: {
            async assertAvailable() {
                preflightCalls += 1;
                throw preflightFailure;
            },
        },
        setConfig: (config) => { current = config; },
    });
    const invalid = nextConfig(initial);
    invalid.web.listenPort = 70_000;

    await assert.rejects(
        engine.commit(initial, invalid, [], runtimeChanges),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                controlErrorCodes.configValidationFailed,
            );
            return true;
        },
    );
    assert.equal(preflightCalls, 0);
    await assert.rejects(
        engine.commit(initial, nextConfig(initial), [], runtimeChanges),
        preflightFailure,
    );
    assert.equal(preflightCalls, 1);

    assert.equal(writes, 0);
    assert.equal(current, initial);
    assert.equal(runtimeCalls, 0);
    assert.equal(hub.revision, 0);
});

test("commit persists before runtime apply and publishes only after success", async () => {
    const previous = createDefaultControlConfig();
    const next = nextConfig(previous);
    let current = previous;
    const events: string[] = [];
    const hub = new ConfigChangeHub();
    hub.onChange(() => events.push("publish"));
    const engine = new ConfigEngine({
        changeHub: hub,
        configStore: { async write(config) { events.push("persist"); assert.equal(current, previous); assert.equal(config.web.listenPort, next.web.listenPort); } },
        getConfig: () => current,
        runtimeApply: { async apply() { events.push("runtime"); assert.equal(current.web.listenPort, next.web.listenPort); return true; } },
        setConfig: (config) => { current = config; },
    });

    await engine.commit(previous, next, [], runtimeChanges, false);

    assert.deepEqual(events, ["persist", "runtime", "publish"]);
    assert.equal(current.web.listenPort, next.web.listenPort);
    assert.equal(hub.revision, 1);
});

test("runtime failure restores persisted and current config without publishing", async () => {
    const previous = createDefaultControlConfig();
    const next = nextConfig(previous);
    let current = previous;
    const persisted: ControlConfig[] = [];
    const hub = new ConfigChangeHub();
    const failure = new Error("runtime failed");
    const engine = new ConfigEngine({
        changeHub: hub,
        configStore: { async write(config) { persisted.push(config); } },
        getConfig: () => current,
        runtimeApply: { async apply() { throw failure; } },
        setConfig: (config) => { current = config; },
    });

    await assert.rejects(engine.commit(previous, next, [], runtimeChanges, false), failure);

    assert.deepEqual(persisted, [next, previous]);
    assert.equal(current, previous);
    assert.equal(hub.revision, 0);
});

test("failed restore write reports both errors without publishing", async () => {
    const previous = createDefaultControlConfig();
    const next = nextConfig(previous);
    let current = previous;
    let writes = 0;
    const hub = new ConfigChangeHub();
    const published: number[] = [];
    hub.onChange((change) => published.push(change.revision));
    const runtimeFailure = new Error("runtime failed");
    const restoreFailure = new Error("restore write failed");
    const engine = new ConfigEngine({
        changeHub: hub,
        configStore: {
            async write() {
                writes += 1;
                if (writes === 2) throw restoreFailure;
            },
        },
        getConfig: () => current,
        runtimeApply: {
            async apply() {
                throw runtimeFailure;
            },
        },
        setConfig: (config) => { current = config; },
    });

    await assert.rejects(
        engine.commit(previous, next, [], runtimeChanges, false),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [runtimeFailure, restoreFailure]);
            return true;
        },
    );

    assert.equal(current, next);
    assert.equal(writes, 2);
    assert.deepEqual(published, []);
    assert.equal(hub.revision, 0);
});
