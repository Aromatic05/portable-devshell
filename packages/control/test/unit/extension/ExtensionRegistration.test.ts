import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionManifest } from "@portable-devshell/extension";
import { nativeCommands } from "@portable-devshell/extension/cli";
import { applications } from "@portable-devshell/extension/web";

import { createControlExtensionPointRegistry } from "../../../src/composition/ControlExtensionPointRegistry.ts";
import { ExtensionRegistrationBuilder } from "../../../src/control/extension/host/generation/ExtensionRegistration.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

function manifest(): ExtensionManifest {
    return {
        apiVersion: 4,
        capabilities: [],
        entry: "extension.mjs",
        extensions: {
            "cli.native-commands": [{ id: "example", title: "Example" }],
            "web.applications": [{ id: "example", title: "Example" }]
        },
        hostDependencies: [],
        id: "example",
        name: "Example",
        schemaVersion: 1,
        version: "1.0.0"
    };
}

test("Extension registration finalization requires exact declared bindings and validates domain resources", async (t) => {
    const root = await createTestTempDirectory("extension-registration");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "web"), { recursive: true });
    const builder = new ExtensionRegistrationBuilder(manifest(), root, createControlExtensionPointRegistry());
    const command = async () => ({ kind: "text" as const, text: "ok" });
    const web = Object.freeze({ source: Object.freeze({ directory: "web", kind: "files" as const }) });

    builder.register(nativeCommands, "example", command);
    builder.register(applications, "example", web);
    const registrations = await builder.finalize();

    assert.equal(registrations.get("cli.native-commands", "example")?.binding, command);
    assert.equal(registrations.get("web.applications", "example")?.binding, web);
    assert.deepEqual(registrations.list("cli.native-commands").map(({ id }) => id), ["example"]);
});

test("Extension registration rejects undeclared, duplicate, and invalid bindings", async () => {
    const builder = new ExtensionRegistrationBuilder(manifest(), "/unused", createControlExtensionPointRegistry());
    assert.throws(
        () => builder.register(nativeCommands, "other", async () => ({ kind: "text", text: "bad" })),
        /registered undeclared cli\.native-commands\/other/u
    );
    builder.register(nativeCommands, "example", async () => ({ kind: "text", text: "ok" }));
    assert.throws(
        () => builder.register(nativeCommands, "example", async () => ({ kind: "text", text: "duplicate" })),
        /more than once/u
    );

    const invalid = new ExtensionRegistrationBuilder(manifest(), "/unused", createControlExtensionPointRegistry());
    assert.throws(
        () => invalid.registerById("web.applications", "example", { source: { kind: "endpoint" } }),
        /must provide resolve/u
    );
});

test("Extension registration rejects a manifest declaration that activate did not bind", async () => {
    const root = await createTestTempDirectory("extension-registration-missing");
    try {
        const builder = new ExtensionRegistrationBuilder(manifest(), root, createControlExtensionPointRegistry());
        builder.register(nativeCommands, "example", async () => ({ kind: "text", text: "ok" }));
        await assert.rejects(builder.finalize(), /declares web\.applications\/example but did not bind it/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
