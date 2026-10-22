import assert from "node:assert/strict";
import test from "node:test";

import {
    assertControlExtensionPointRegistryParity,
    createControlExtensionPointRegistry,
} from "../../../../src/extension/registration/Points.ts";
import { createControlExtensionSandboxPointRegistry } from "../../../../src/extension/registration/Points.ts";

test("Control composes the same Extension Point ids for host validation and sandbox codecs", () => {
    const points = createControlExtensionPointRegistry();
    const sandbox = createControlExtensionSandboxPointRegistry();

    assert.deepEqual(points.ids(), sandbox.ids());
    assert.deepEqual(points.ids(), [...points.ids()].sort());
});

test("Control rejects a point-definition and sandbox-codec composition drift", () => {
    assert.throws(
        () =>
            assertControlExtensionPointRegistryParity(
                { ids: () => ["cli.native-commands", "web.applications"] },
                { ids: () => ["cli.native-commands"] },
            ),
        /registry and sandbox codec registry are out of sync/u,
    );
    assert.throws(
        () =>
            assertControlExtensionPointRegistryParity(
                { ids: () => ["cli.native-commands"] },
                { ids: () => ["cli.native-commands", "web.applications"] },
            ),
        /registry and sandbox codec registry are out of sync/u,
    );
});

test("Control domain point definitions own declaration schema validation", () => {
    const points = createControlExtensionPointRegistry();

    assert.deepEqual(
        points.parseDeclaration(
            "cli.native-commands",
            {
                id: "agent",
                summary: "Run an Agent",
                title: "Agent",
                usage: "agent <command>",
            },
            "example",
        ),
        {
            id: "agent",
            summary: "Run an Agent",
            title: "Agent",
            usage: "agent <command>",
        },
    );
    assert.deepEqual(
        points.parseDeclaration(
            "web.applications",
            {
                id: "agent",
                title: "Agent",
            },
            "example",
        ),
        {
            id: "agent",
            title: "Agent",
        },
    );
    assert.deepEqual(
        points.parseDeclaration(
            "toolcall.review",
            { hook: "500-comment", id: "comment" },
            "example",
        ),
        { hook: "500-comment", id: "comment" },
    );
    assert.deepEqual(
        points.parseDeclaration(
            "toolcall.rewrite",
            { hook: "500-secret", id: "secret" },
            "example",
        ),
        { hook: "500-secret", id: "secret" },
    );
    assert.throws(
        () =>
            points.parseDeclaration(
                "toolcall.rewrite",
                { hook: "500-secret", id: "secret", priority: 10 },
                "example",
            ),
        /unknown field/u,
    );
    assert.throws(
        () =>
            points.parseDeclaration(
                "toolcall.review",
                { hook: "comment", id: "comment" },
                "example",
            ),
        /NNN-name/u,
    );
    assert.throws(
        () =>
            points.parseDeclaration(
                "toolcall.review",
                { hook: "000-comment", id: "comment" },
                "example",
            ),
        /001 through 999/u,
    );
    assert.throws(
        () =>
            points.parseDeclaration(
                "cli.native-commands",
                {
                    id: "agent",
                    title: "Agent",
                    transport: "rpc",
                },
                "example",
            ),
        /unknown field/u,
    );
    assert.throws(
        () =>
            points.parseDeclaration(
                "web.applications",
                {
                    id: "agent",
                    title: " Agent ",
                },
                "example",
            ),
        /non-empty trimmed string/u,
    );
});

test("execution provider declarations and descriptors validate and cross the sandbox codec as JSON", async () => {
    const points = createControlExtensionPointRegistry();
    const codecs = createControlExtensionSandboxPointRegistry();
    for (const pointId of ["execution.environment", "execution.sandbox"]) {
        assert.deepEqual(points.parseDeclaration(pointId, { id: "direnv" }, "direnv"), { id: "direnv" });
        assert.throws(() => points.parseDeclaration(pointId, { id: "direnv", priority: 1 }, "direnv"), /unknown field/u);
        const context = { codeDirectory: "/tmp/direnv", extensionId: "direnv", id: "direnv" };
        const binding = { name: "direnv", version: 1, executable: "direnv", args: ["export", "json"] };
        points.validateBinding(pointId, binding, context);
        assert.throws(() => points.validateBinding(pointId, { ...binding, name: "other" }, context), /name matches/u);
        const descriptor = codecs.describeBinding(pointId, binding, context);
        assert.deepEqual(descriptor, binding);
        const recreated = points.createSandboxBinding(pointId, descriptor, context, { invokeBinding: async () => undefined });
        assert.deepEqual(recreated, binding);
    }
    assert.deepEqual(
        points.parseDeclaration("execution.environment", { id: "direnv", automatic: true }, "direnv"),
        { id: "direnv", automatic: true },
    );
    assert.throws(
        () => points.parseDeclaration("execution.environment", { id: "direnv", automatic: "yes" }, "direnv"),
        /automatic must be a boolean/u,
    );
    assert.throws(
        () => points.parseDeclaration("execution.sandbox", { id: "sandbox", automatic: true }, "example"),
        /unknown field/u,
    );
});
