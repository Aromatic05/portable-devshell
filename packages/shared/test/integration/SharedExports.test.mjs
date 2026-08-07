import assert from "node:assert/strict";
import test from "node:test";

const {
    applyConfigInstancePatch,
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
    parseConfigInstancePatch,
    validateConfigSemantics,
    validateEvent
} = await import("@portable-devshell/shared");

test("config patch has explicit null clearing and strict unknown-field parsing", () => {
    const current = normalizeConfigInstanceDraft(parseConfigInstanceDraft({
        container: {
            image: "archlinux:latest",
            mode: "existingImage"
        },
        dockerBinary: "docker",
        name: "demo-docker",
        provider: "docker",
        workspace: "/workspace/demo"
    }));
    const next = normalizeConfigInstanceDraft(applyConfigInstancePatch(current, parseConfigInstancePatch({
        dockerBinary: null
    })));

    assert.equal(next.dockerBinary, undefined);
    assert.throws(() => parseConfigInstanceDraft({
        name: "demo-local",
        provider: "local",
        workspace: "/workspace/demo",
        workspacePath: "/legacy"
    }), /workspacePath is not supported/u);
});

test("semantic validation accepts normalized canonical config", () => {
    const config = createDefaultControlConfig();
    config.instances.push(normalizeConfigInstanceDraft({
        name: "demo-local",
        provider: "local",
        workspace: "/workspace/demo"
    }));

    assert.equal(validateConfigSemantics(config), config);
});

test("validateEvent accepts the Event contract and rejects old envelopes", () => {
    assert.deepEqual(validateEvent({
        id: "req-1",
        from: "cli",
        to: "server",
        destination: "@control",
        name: "service.ping"
    }), {
        id: "req-1",
        from: "cli",
        to: "server",
        destination: "@control",
        name: "service.ping"
    });

    assert.throws(() => validateEvent({
        id: "req-1",
        method: "control.ping",
        target: { kind: "control" },
        type: "request"
    }));
});
