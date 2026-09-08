import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ExtensionHostModuleResolver } from "../../../src/control/extension/host/generation/ExtensionHostModuleResolver.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Extension host module resolver falls back to shared application dependencies only for a live generation", async (t) => {
    const root = await createTestTempDirectory("extension-host-modules");
    const generation = join(root, "generation");
    await mkdir(generation, { recursive: true });
    await writeFile(
        join(generation, "one.mjs"),
        "import { Client } from '@modelcontextprotocol/client'; export const value = typeof Client;\n",
        "utf8"
    );
    await writeFile(
        join(generation, "two.mjs"),
        "import { Client } from '@modelcontextprotocol/client'; export const value = typeof Client;\n",
        "utf8"
    );
    await writeFile(
        join(generation, "one.cjs"),
        "const { Client } = require('@modelcontextprotocol/client'); module.exports = { value: typeof Client };\n",
        "utf8"
    );
    const resolver = new ExtensionHostModuleResolver(import.meta.url);
    t.after(async () => {
        resolver.dispose();
        await rm(root, { force: true, recursive: true });
    });

    const lease = resolver.register(generation);
    const loaded = await import(`${pathToFileURL(join(generation, "one.mjs")).href}?registered=1`);
    assert.equal(loaded.value, "function");
    const loadedCjs = await import(`${pathToFileURL(join(generation, "one.cjs")).href}?registered=1`);
    assert.equal(loadedCjs.default.value, "function");

    lease.release();
    await assert.rejects(
        import(`${pathToFileURL(join(generation, "two.mjs")).href}?released=1`),
        (error: unknown) => error instanceof Error && error.message.includes("@modelcontextprotocol/client")
    );
});
