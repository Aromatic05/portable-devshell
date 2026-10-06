import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createExtensionRuntime } from "../../../../../src/extension/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

test("Extension runtime owns paths, registry, points, and loader lifecycle", async (t) => {
    const root = await createTestTempDirectory("extension-runtime");
    const runtime = createExtensionRuntime({
        instances: { list: () => [] } as never,
        pathOptions: {
            dataHome: join(root, "data"),
            homeDirectory: join(root, "home"),
            runtimeRoot: join(root, "runtime"),
        },
        readToolCalls: async () => [],
    });

    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });

    await runtime.start();

    assert.deepEqual(await runtime.control.list(), []);
    assert.equal(
        runtime.generationDirectory("example", "v1"),
        join(
            root,
            "data",
            "portable-devshell",
            "extensions",
            "example",
            "v1",
        ),
    );
});
