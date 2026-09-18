import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { activate } from "../../src/builtin/index.ts";
import { secretExtensionDirectory } from "../../src/index.ts";

test("Secret Extension declares and activates one toolcall.rewrite binding", async () => {
    const registrations: Array<{ id: string; pointId: string }> = [];
    activate({
        capabilities: {},
        register(point: { id: string }, id: string) {
            registrations.push({ id, pointId: point.id });
        },
    } as unknown as ExtensionContext);

    assert.deepEqual(registrations, [
        { id: "secret", pointId: "cli.native-commands" },
        { id: "secret", pointId: "cli.model-commands" },
        { id: "secret", pointId: "toolcall.rewrite" },
    ]);

    const manifest = JSON.parse(
        await readFile(
            new URL("../../src/builtin/devshell-extension.json", import.meta.url),
            "utf8",
        ),
    ) as { extensions?: Record<string, unknown> };
    assert.deepEqual(manifest.extensions?.["toolcall.rewrite"], [
        { id: "secret" },
    ]);
});


test("Secret builtin source is a self-contained 5x5 runtime tree", async () => {
    assert.deepEqual(
        (await readdir(secretExtensionDirectory())).sort(),
        [
            "command",
            "devshell-extension.json",
            "index.ts",
            "rewrite",
            "scan",
        ],
    );
});
