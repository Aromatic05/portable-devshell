import assert from "node:assert/strict";
import test from "node:test";

const {
    applyConfigInstancePatch,
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
    parseConfigInstancePatch,
    validateConfigSemantics,
} = await import("@portable-devshell/shared");

test("config patch has explicit null clearing and strict unknown-field parsing", () => {
    const current = normalizeConfigInstanceDraft(
        parseConfigInstanceDraft({
            container: {
                image: "archlinux:latest",
                mode: "existingImage",
            },
            dockerBinary: "docker",
            name: "demo-docker",
            provider: "docker",
        }),
    );
    const next = normalizeConfigInstanceDraft(
        applyConfigInstancePatch(
            current,
            parseConfigInstancePatch({
                dockerBinary: null,
            }),
        ),
    );

    assert.equal(next.dockerBinary, undefined);
    assert.throws(
        () =>
            parseConfigInstanceDraft({
                name: "demo-local",
                provider: "local",
                workspacePath: "/legacy",
            }),
        /workspacePath is not supported/u,
    );
});

test("semantic validation accepts normalized canonical config", () => {
    const config = createDefaultControlConfig();
    config.instances.push(
        normalizeConfigInstanceDraft({
            name: "demo-local",
            provider: "local",
        }),
    );

    assert.equal(validateConfigSemantics(config), config);
});
