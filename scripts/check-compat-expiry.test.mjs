import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";
import {
    CompatibilityExpiryError,
    checkCompatibilityExpiry,
    parseCompatibilityAnnotations,
} from "./check-compat-expiry.mjs";

async function createFixture(version, sources) {
    const root = await createTestTempDirectory("compat-expiry");
    await writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ version })}\n`,
        "utf8",
    );
    for (const [path, source] of Object.entries(sources)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), source, "utf8");
    }
    return root;
}

test("compat annotations remain valid before their removal release", async () => {
    const source = [
        "/**",
        " * @compat worker-protocol-7",
        " * @removeAt 0.8.0",
        " */",
        "export const legacy = 7;",
    ].join("\n");
    const root = await createFixture("0.7.6", { "src/legacy.ts": source });
    try {
        const result = await checkCompatibilityExpiry({
            files: ["src/legacy.ts"],
            root,
        });
        assert.deepEqual(result.annotations, [
            {
                compat: "worker-protocol-7",
                line: 1,
                path: "src/legacy.ts",
                removeAt: "0.8.0",
            },
        ]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("compat annotations expire at the declared release boundary", async () => {
    const root = await createFixture("0.8.0", {
        "src/legacy.rs": [
            "// @compat worker-protocol-7",
            "// @removeAt 0.8.0",
            "const LEGACY: u32 = 7;",
        ].join("\n"),
    });
    try {
        await assert.rejects(
            () =>
                checkCompatibilityExpiry({
                    files: ["src/legacy.rs"],
                    root,
                }),
            (error) => {
                assert.equal(error instanceof CompatibilityExpiryError, true);
                assert.equal(error.issues.length, 1);
                assert.deepEqual(error.issues[0], {
                    compat: "worker-protocol-7",
                    currentVersion: "0.8.0",
                    kind: "expired",
                    line: 1,
                    path: "src/legacy.rs",
                    removeAt: "0.8.0",
                });
                return true;
            },
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("compat and removal annotations must be paired in one source comment", () => {
    const parsed = parseCompatibilityAnnotations(
        [
            "// @compat config-v2",
            "const marker = '@removeAt 9.9.9';",
        ].join("\n"),
        "src/config.ts",
    );
    assert.equal(parsed.annotations.length, 0);
    assert.deepEqual(parsed.issues, [
        {
            kind: "invalid-annotation",
            line: 1,
            path: "src/config.ts",
        },
    ]);
});

test("generated outputs are outside the compatibility expiry source surface", async () => {
    const source = [
        "/**",
        " * @compat generated-copy",
        " * @removeAt 0.1.0",
        " */",
    ].join("\n");
    const root = await createFixture("0.7.6", {
        "packages/demo/dist/generated.js": source,
        "target/generated.rs": source,
    });
    try {
        const result = await checkCompatibilityExpiry({
            files: [
                "packages/demo/dist/generated.js",
                "target/generated.rs",
            ],
            root,
        });
        assert.deepEqual(result.annotations, []);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Rust attributes are not folded into shell-style compatibility comments", () => {
    const parsed = parseCompatibilityAnnotations(
        [
            "#[derive(Debug)]",
            "#[serde(untagged)]",
            "// @compat legacy-wire",
            "// @removeAt 1.0.0",
            "enum Input {}",
        ].join("\n"),
        "src/input.rs",
    );
    assert.deepEqual(parsed.annotations, [
        {
            compat: "legacy-wire",
            line: 3,
            path: "src/input.rs",
            removeAt: "1.0.0",
        },
    ]);
    assert.deepEqual(parsed.issues, []);
});
