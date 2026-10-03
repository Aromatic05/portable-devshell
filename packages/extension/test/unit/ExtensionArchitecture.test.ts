import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
    EXTENSION_CAPABILITY_IDS as rootCapabilityIds,
    defineExtensionPoint as defineRootExtensionPoint,
    type ExtensionJsonValue,
} from "../../src/index.ts";
import { EXTENSION_CAPABILITY_IDS as capabilityIds } from "../../src/ExtensionCapability.ts";
import { defineExtensionPoint as defineCoreExtensionPoint } from "../../src/ExtensionCore.ts";

test("Extension root re-exports core primitives without wrapping them", () => {
    const value: ExtensionJsonValue = { enabled: true };

    assert.deepEqual(value, { enabled: true });
    assert.equal(rootCapabilityIds, capabilityIds);
    assert.equal(defineRootExtensionPoint, defineCoreExtensionPoint);
});

test("Extension manifest contract does not depend on the composed runtime API", async () => {
    const source = await readFile(
        new URL("../../src/ExtensionManifest.ts", import.meta.url),
        "utf8",
    );

    assert.doesNotMatch(source, /ExtensionApi\.js/u);
});

test("Extension domain modules never depend on the composed ExtensionApi layer", async () => {
    const domainDirectory = new URL("../../src/domain/", import.meta.url);
    const files = (await readdir(domainDirectory))
        .filter((file) => file.endsWith(".ts"))
        .sort();

    for (const file of files) {
        const source = await readFile(new URL(file, domainDirectory), "utf8");
        assert.doesNotMatch(
            source,
            /ExtensionApi\.js/u,
            file +
                " must depend on ExtensionCore or another leaf domain, not ExtensionApi",
        );
    }
});

test("Extension package publishes every domain as one leaf subpath without root aggregation", async () => {
    const domainDirectory = new URL("../../src/domain/", import.meta.url);
    const domains = (await readdir(domainDirectory))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => file.slice(0, -3))
        .sort();
    const packageJson = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
        exports: Record<string, { default: string; types: string }>;
    };
    const exportedDomains = Object.keys(packageJson.exports)
        .filter((key) => key !== "." && key.startsWith("./"))
        .map((key) => key.slice(2))
        .sort();

    assert.deepEqual(exportedDomains, domains);
    for (const domain of domains) {
        assert.deepEqual(packageJson.exports["./" + domain], {
            default: "./dist/domain/" + domain + ".js",
            types: "./dist/domain/" + domain + ".d.ts",
        });
    }

    const rootSource = await readFile(
        new URL("../../src/index.ts", import.meta.url),
        "utf8",
    );
    assert.doesNotMatch(rootSource, /\.\/domain\//u);
});
