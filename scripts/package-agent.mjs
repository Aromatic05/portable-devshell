import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const piProviderManifest = resolve(repoRoot, "extensions/agent/src/provider/pi/devshell-agent-provider.json");
const openCodeProviderManifest = resolve(repoRoot, "extensions/agent/src/provider/opencode/devshell-agent-provider.json");
const providerDefinitions = [
    {
        id: "pi",
        manifest: piProviderManifest,
        shape: shapePiProviderTree
    },
    {
        id: "opencode",
        manifest: openCodeProviderManifest,
        shape: shapeOpenCodeProviderTree
    }
];

export async function packageAgentArtifacts(options = {}) {
    const includeExtension = options.includeExtension ?? true;
    const includeProvider = options.includeProvider ?? true;
    if (!includeExtension && !includeProvider) {
        throw new Error("Agent packaging must include the Extension, a provider, or both");
    }
    const outputDirectory = resolve(repoRoot, options.outputDirectory ?? "release-assets");
    const target = options.target ?? hostTarget();
    if (includeProvider && target !== hostTarget()) {
        throw new Error(`cannot package Agent provider ${target} on ${hostTarget()}; package provider native dependencies on the target platform`);
    }
    const stagingRoot = await mkdtemp(resolve(repoRoot, ".portable-devshell-agent-"));
    const extensionDirectory = resolve(stagingRoot, "agent-extension");
    const providerDirectories = Object.fromEntries(providerDefinitions.map((provider) => [
        provider.id,
        resolve(stagingRoot, `${provider.id}-provider`)
    ]));
    const extensionAsset = includeExtension ? resolve(outputDirectory, "portable-devshell-agent.dsext") : undefined;
    const providerAssets = includeProvider
        ? Object.fromEntries(providerDefinitions.map((provider) => [
            provider.id,
            resolve(outputDirectory, `portable-devshell-agent-provider-${provider.id}-${target}.dsprovider`)
        ]))
        : {};

    try {
        await mkdir(outputDirectory, { recursive: true });
        buildWorkspacePackage("@portable-devshell/agent-extension");
        buildWorkspacePackage("@portable-devshell/control");
        if (includeExtension) deployWorkspacePackage("@portable-devshell/agent-extension", extensionDirectory);
        if (includeProvider) {
            for (const provider of providerDefinitions) {
                deployWorkspacePackage("@portable-devshell/agent-extension", providerDirectories[provider.id]);
            }
        }
        await Promise.all([
            ...(includeExtension ? [sanitizeDeployTree(extensionDirectory)] : []),
            ...(includeProvider ? providerDefinitions.map((provider) => sanitizeDeployTree(providerDirectories[provider.id])) : [])
        ]);
        if (includeExtension) await shapeThinAgentExtensionTree(extensionDirectory);
        if (includeProvider) {
            for (const provider of providerDefinitions) {
                await provider.shape(providerDirectories[provider.id]);
                await pruneProviderRuntimeTree(providerDirectories[provider.id]);
            }
        }
        await Promise.all([
            ...(includeExtension ? [assertNoSymbolicLinks(extensionDirectory), assertThinAgentExtensionTree(extensionDirectory)] : []),
            ...(includeProvider ? providerDefinitions.map((provider) => assertNoSymbolicLinks(providerDirectories[provider.id])) : [])
        ]);

        if (extensionAsset !== undefined) await rm(extensionAsset, { force: true });
        await Promise.all(Object.values(providerAssets).map((asset) => rm(asset, { force: true })));
        const archiveModule = await import(pathToFileURL(resolve(
            repoRoot,
            "packages/control/dist/control/artifact/host/ArtifactHostArchive.js"
        )).href);
        if (extensionAsset !== undefined) {
            await archiveModule.createArtifactDirectoryArchive(extensionDirectory, extensionAsset);
        }
        for (const provider of providerDefinitions) {
            const asset = providerAssets[provider.id];
            if (asset !== undefined) {
                await archiveModule.createArtifactDirectoryArchive(providerDirectories[provider.id], asset);
            }
        }
        await Promise.all([
            ...(extensionAsset === undefined ? [] : [writeSha256(extensionAsset)]),
            ...Object.values(providerAssets).map((asset) => writeSha256(asset))
        ]);
        return {
            extensionAsset,
            providerAsset: providerAssets.pi,
            providerAssets,
            target
        };
    } finally {
        await rm(stagingRoot, { force: true, recursive: true });
    }
}

export async function sanitizeDeployTree(root) {
    await removeNodeModulesDeploymentMetadata(root);
    await rm(join(root, "pnpm-lock.yaml"), { force: true });
}

async function removeNodeModulesDeploymentMetadata(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const insideNodeModules = basename(directory) === "node_modules";
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (insideNodeModules && entry.isDirectory() && (entry.name === ".bin" || entry.name === ".pnpm")) {
            await rm(path, { force: true, recursive: true });
            continue;
        }
        if (
            insideNodeModules
            && entry.isFile()
            && (entry.name === ".modules.yaml" || entry.name === ".pnpm-workspace-state-v1.json")
        ) {
            await rm(path, { force: true });
            continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await removeNodeModulesDeploymentMetadata(path);
        }
    }
}

export async function pruneProviderRuntimeTree(root) {
    await pruneNodeModulesRuntimeTree(join(root, "node_modules"));
}

async function pruneNodeModulesRuntimeTree(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            if (entry.name === "test" || entry.name === "tests" || entry.name === "__tests__") {
                await rm(path, { force: true, recursive: true });
                continue;
            }
            await pruneNodeModulesRuntimeTree(path);
            continue;
        }
        if (entry.isFile() && (entry.name.endsWith(".d.ts") || entry.name.endsWith(".map"))) {
            await rm(path, { force: true });
        }
    }
}

export async function shapeThinAgentExtensionTree(root) {
    await rm(join(root, "dist", "provider"), { force: true, recursive: true });
    const builtinManifest = JSON.parse(await readFile(join(root, "dist", "builtin", "devshell-extension.json"), "utf8"));
    await writeFile(
        join(root, "devshell-extension.json"),
        `${JSON.stringify({ ...builtinManifest, entry: "dist/builtin/index.js" }, null, 4)}\n`,
        "utf8"
    );
    await rm(join(root, "node_modules"), { force: true, recursive: true });
    await rewriteDeploymentPackage(root, {
        dependencies: {
            "@portable-devshell/extension": "workspace:*"
        },
        entry: "./dist/index.js",
        name: "@portable-devshell/agent-extension",
        version: builtinManifest.version
    });
}

export async function shapePiProviderTree(root) {
    const providerManifest = JSON.parse(await readFile(piProviderManifest, "utf8"));
    const dependencies = {
        "@earendil-works/pi-coding-agent": "0.85.1",
        "@earendil-works/pi-tui": "0.85.1",
        "@portable-devshell/shared": "workspace:*",
        "diff": "9.0.0",
        "pi-gui-extension": "0.4.1",
        "typebox": "1.3.30"
    };
    await shapeProviderTree(root, {
        dependencies,
        entry: "./dist/provider/pi/index.js",
        id: "pi",
        manifest: piProviderManifest,
        name: "@portable-devshell-internal/agent-provider-pi",
        version: providerManifest.version
    });
}

export async function shapeOpenCodeProviderTree(root) {
    const providerManifest = JSON.parse(await readFile(openCodeProviderManifest, "utf8"));
    const dependencies = {
        "@agentclientprotocol/sdk": "1.4.0",
        "@modelcontextprotocol/node": "2.0.0",
        "@modelcontextprotocol/server": "2.0.0",
        "opencode-ai": "1.18.30"
    };
    await shapeProviderTree(root, {
        dependencies,
        entry: "./dist/provider/opencode/index.js",
        id: "opencode",
        manifest: openCodeProviderManifest,
        name: "@portable-devshell-internal/agent-provider-opencode",
        version: providerManifest.version
    });
}

async function shapeProviderTree(root, options) {
    const providerTree = join(root, `.${options.id}-provider-dist`);
    const projectionSource = join(root, "dist", "builtin", "provider", "AgentToolProjection.js");
    const projectionTree = join(root, ".agent-tool-projection.js");
    await rename(join(root, "dist", "provider", options.id), providerTree);
    await copyFile(projectionSource, projectionTree);
    await rm(join(root, "dist"), { force: true, recursive: true });
    await mkdir(join(root, "dist", "provider"), { recursive: true });
    await mkdir(join(root, "dist", "builtin", "provider"), { recursive: true });
    await rename(providerTree, join(root, "dist", "provider", options.id));
    await rename(projectionTree, join(root, "dist", "builtin", "provider", "AgentToolProjection.js"));
    await copyFile(options.manifest, join(root, "devshell-agent-provider.json"));
    await rm(join(root, "devshell-extension.json"), { force: true });
    await rewriteDeploymentPackage(root, options);
    await retainProviderDependencies(root, Object.keys(options.dependencies), options.id);
}

async function retainProviderDependencies(root, directDependencies, providerId) {
    const nodeModules = join(root, "node_modules");
    const retained = new Set(directDependencies);
    const pending = [...directDependencies];
    while (pending.length > 0) {
        const name = pending.pop();
        const packageRoot = join(nodeModules, ...name.split("/"));
        let manifest;
        try {
            manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        const dependencies = {
            ...(manifest.dependencies ?? {}),
            ...(manifest.optionalDependencies ?? {})
        };
        for (const dependency of Object.keys(dependencies)) {
            if (providerId === "opencode" && name === "opencode-ai" && dependency.startsWith("opencode-")) {
                if (dependency !== openCodeRuntimePackageForHost()) continue;
            }
            if (retained.has(dependency)) continue;
            retained.add(dependency);
            pending.push(dependency);
        }
    }

    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = join(nodeModules, entry.name);
        if (!entry.name.startsWith("@")) {
            if (!retained.has(entry.name)) await rm(entryPath, { force: true, recursive: true });
            continue;
        }
        for (const scoped of await readdir(entryPath, { withFileTypes: true })) {
            const name = `${entry.name}/${scoped.name}`;
            if (!retained.has(name)) await rm(join(entryPath, scoped.name), { force: true, recursive: true });
        }
        if ((await readdir(entryPath)).length === 0) await rm(entryPath, { force: true, recursive: true });
    }
}

function openCodeRuntimePackageForHost() {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const base = `opencode-${platform}-${process.arch}`;
    return process.arch === "x64" ? `${base}-baseline` : base;
}

export async function assertNoSymbolicLinks(root) {
    await walk(root, async (_path, relativePath, metadata) => {
        if (metadata.isSymbolicLink()) {
            throw new Error(`packaged Agent artifact contains symbolic link: ${relativePath}`);
        }
    });
}

export async function assertThinAgentExtensionTree(root) {
    await walk(root, async (_path, relativePath) => {
        const normalized = relativePath.replaceAll("\\", "/");
        if (normalized === "node_modules" || normalized.startsWith("node_modules/")) {
            throw new Error(`Agent Extension payload must not contain private node_modules: ${normalized}`);
        }
        if (normalized === "dist/provider" || normalized.startsWith("dist/provider/")) {
            throw new Error(`Agent Extension payload must not contain provider/runtime content: ${normalized}`);
        }
    });
}

export function hostTarget() {
    const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
    if (arch === undefined) throw new Error(`unsupported host architecture: ${process.arch}`);
    return `${os}-${arch}`;
}

async function rewriteDeploymentPackage(root, options) {
    const path = join(root, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.name = options.name;
    manifest.version = options.version;
    manifest.main = options.entry;
    manifest.types = options.entry.replace(/\.js$/u, ".d.ts");
    manifest.exports = {
        ".": {
            types: manifest.types,
            default: manifest.main
        }
    };
    manifest.dependencies = options.dependencies;
    await writeFile(path, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
}

async function walk(root, visit) {
    const descend = async (directory, prefix) => {
        const names = await readdir(directory);
        names.sort();
        for (const name of names) {
            const path = join(directory, name);
            const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
            const metadata = await lstat(path);
            await visit(path, relativePath, metadata);
            if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
                await descend(path, relativePath);
            }
        }
    };
    await descend(root, "");
}

function buildWorkspacePackage(name) {
    runPnpm(["-r", "--workspace-concurrency=1", "--filter", `${name}...`, "build"]);
}

function deployWorkspacePackage(name, targetDirectory) {
    runPnpm([
        "--config.node-linker=hoisted",
        "--filter",
        name,
        "--prod",
        "deploy",
        "--legacy",
        relative(repoRoot, targetDirectory)
    ]);
}

function runPnpm(args) {
    const command = resolvePnpmCommand();
    const result = spawnSync(command.command, [...command.args, ...args], {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit"
    });
    if (result.status !== 0) {
        throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
    }
}

async function writeSha256(path) {
    const content = await readFile(path);
    const digest = createHash("sha256").update(content).digest("hex");
    await writeFile(`${path}.sha256`, `${digest}  ${path.split(/[\\/]/u).at(-1)}\n`, "utf8");
}

function readOption(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
}

export function resolveAgentPackageSelection(args) {
    const providerOnly = args.includes("--provider-only");
    const extensionOnly = args.includes("--extension-only");
    if (providerOnly && extensionOnly) {
        throw new Error("--provider-only and --extension-only are mutually exclusive");
    }
    return {
        includeExtension: !providerOnly,
        includeProvider: !extensionOnly
    };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const selection = resolveAgentPackageSelection(args);
    const result = await packageAgentArtifacts({
        ...selection,
        outputDirectory: readOption(args, "--output-dir"),
        target: readOption(args, "--target")
    });
    if (result.extensionAsset !== undefined) {
        process.stdout.write(`${result.extensionAsset}\n${result.extensionAsset}.sha256\n`);
    }
    for (const providerAsset of Object.values(result.providerAssets)) {
        process.stdout.write(`${providerAsset}\n${providerAsset}.sha256\n`);
    }
}
