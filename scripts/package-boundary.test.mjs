import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const boundedPackages = ["core", "control", "mcp", "tui"];

const rootEntrypoints = {
    control: ["./server/ControlDaemon.js"],
    core: [
        "./instance/InstancePaths.js",
        "./worker/command/WorkerCommandTransport.js",
        "./worker/instance/WorkerInstance.js",
        "./worker/instance/WorkerInstanceConfig.js",
        "./worker/instance/WorkerInstanceFactory.js",
        "./worker/platform/WorkerHomeDirectory.js",
        "./worker/protocol/WorkerProtocolClient.js",
        "./worker/rpc/WorkerRpcChannel.js",
        "./worker/rpc/WorkerRpcInboundConnector.js",
        "./worker/transport/factory/WorkerTransportFactory.js"
    ],
    mcp: [
        "./auth/McpAuthConfig.js",
        "./auth/oauth/McpOAuthApprovalService.js",
        "./host/McpHost.js",
        "./host/McpHostHttpServer.js",
        "./instance/McpInstanceGateway.js"
    ],
    tui: ["./main.js"]
};

const productionRootImport = /from\s+["']@portable-devshell\/(core|control|mcp|tui)["']/gu;
const testRootImport = /from\s+["']@portable-devshell\/(core|control|mcp|tui)["']/gu;

test("bounded packages expose one production root and one explicit testing entrypoint", async () => {
    for (const packageName of boundedPackages) {
        const manifest = await readJson(`packages/${packageName}/package.json`);
        assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./testing"]);
        assert.deepEqual(manifest.exports["./testing"], {
            default: "./dist/testing.js",
            types: "./dist/testing.d.ts"
        });
    }
});

test("production roots export only the declared downstream contract", async () => {
    for (const [packageName, expected] of Object.entries(rootEntrypoints)) {
        const source = await readText(`packages/${packageName}/src/index.ts`);
        const specifiers = [...new Set(
            [...source.matchAll(/from\s+["']([^"']+)["']/gu)]
                .map((match) => match[1])
        )].sort();
        assert.deepEqual(specifiers, [...expected].sort(), `${packageName} root exports drifted`);
        assert.equal(source.includes("export *"), false, `${packageName} root must use explicit named exports`);
    }
});

test("testing entrypoints exist and keep package-local architecture available", async () => {
    for (const packageName of boundedPackages) {
        const source = await readText(`packages/${packageName}/src/testing.ts`);
        assert.match(source, /export/u);
        assert.match(source, /from/u);
        assert.ok(source.split(/\r?\n/u).length >= 10, `${packageName}/testing.ts is unexpectedly narrow`);
    }
});

test("TypeScript resolves production and testing package entrypoints explicitly", async () => {
    const config = await readJson("tsconfig.base.json");
    for (const packageName of boundedPackages) {
        assert.deepEqual(
            config.compilerOptions.paths[`@portable-devshell/${packageName}/testing`],
            [`./packages/${packageName}/dist/testing.d.ts`]
        );
    }
});

test("source code never crosses package boundaries through dist or undeclared subpaths", async () => {
    const files = await sourceFiles("packages");
    const violations = [];
    for (const file of files) {
        const source = await readText(file);
        for (const line of source.split(/\r?\n/u)) {
            const relativeCrossPackageDist = /(?:\.\.\/){1,5}(?:core|control|mcp|tui)\/dist\//u.test(line);
            const packageLocalProductionIndex = file.includes("/test/") && /(?:\.\.\/)+dist\/index\.js/u.test(line);
            const packageSpecifiers = [...line.matchAll(/@portable-devshell\/(core|control|mcp|tui)\/([^"']+)/gu)];
            const undeclaredSubpath = packageSpecifiers.some((match) => match[2] !== "testing");
            if (relativeCrossPackageDist || packageLocalProductionIndex || undeclaredSubpath) {
                violations.push(`${file}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test("production sources use package roots while tests use explicit testing contracts", async () => {
    const files = await sourceFiles("packages");
    const violations = [];
    for (const file of files) {
        const source = await readText(file);
        if (file.includes("/src/")) {
            for (const match of source.matchAll(productionRootImport)) {
                const dependency = match[1];
                if (!allowedProductionDependency(file, dependency)) {
                    violations.push(`${file}: unexpected production dependency @portable-devshell/${dependency}`);
                }
            }
            continue;
        }
        if (!file.includes("/test/")) {
            continue;
        }
        for (const match of source.matchAll(testRootImport)) {
            violations.push(`${file}: use @portable-devshell/${match[1]}/testing in tests`);
        }
    }
    assert.deepEqual(violations, []);
});

function allowedProductionDependency(file, dependency) {
    if (file.startsWith("packages/control/src/")) {
        return dependency === "core" || dependency === "mcp";
    }
    if (file.startsWith("packages/cli/src/")) {
        return dependency === "control" || dependency === "tui";
    }
    return false;
}

async function sourceFiles(directory) {
    const output = [];
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        const entries = await readdir(new URL(current, root), { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name === "dist") {
                continue;
            }
            const child = join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(child);
                continue;
            }
            if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
                output.push(child);
            }
        }
    }
    return output.sort();
}

async function readJson(path) {
    return JSON.parse(await readText(path));
}

async function readText(path) {
    return await readFile(new URL(path, root), "utf8");
}
