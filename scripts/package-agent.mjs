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
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const piProviderManifest = resolve(repoRoot, "extensions/agent/src/provider/pi/devshell-agent-provider.json");

export async function packageAgentArtifacts(options = {}) {
    const outputDirectory = resolve(repoRoot, options.outputDirectory ?? "release-assets");
    const target = options.target ?? hostTarget();
    if (target !== hostTarget()) {
        throw new Error(`cannot package Agent provider ${target} on ${hostTarget()}; package provider native dependencies on the target platform`);
    }
    const stagingRoot = await mkdtemp(resolve(repoRoot, ".portable-devshell-agent-"));
    const extensionDirectory = resolve(stagingRoot, "agent-extension");
    const providerDirectory = resolve(stagingRoot, "pi-provider");
    const extensionAsset = resolve(outputDirectory, "portable-devshell-agent.dsext");
    const providerAsset = resolve(outputDirectory, `portable-devshell-agent-provider-pi-${target}.dsprovider`);

    try {
        await mkdir(outputDirectory, { recursive: true });
        buildWorkspacePackage("@portable-devshell/agent-extension");
        buildWorkspacePackage("@portable-devshell/control");
        deployWorkspacePackage("@portable-devshell/agent-extension", extensionDirectory);
        deployWorkspacePackage("@portable-devshell/agent-extension", providerDirectory);
        await Promise.all([
            sanitizeDeployTree(extensionDirectory),
            sanitizeDeployTree(providerDirectory)
        ]);
        await Promise.all([
            shapeThinAgentExtensionTree(extensionDirectory),
            shapePiProviderTree(providerDirectory)
        ]);
        await Promise.all([
            assertNoSymbolicLinks(extensionDirectory),
            assertNoSymbolicLinks(providerDirectory),
            assertThinAgentExtensionTree(extensionDirectory)
        ]);

        await rm(extensionAsset, { force: true });
        await rm(providerAsset, { force: true });
        const archiveModule = await import(pathToFileURL(resolve(
            repoRoot,
            "packages/control/dist/control/artifact/host/ArtifactHostArchive.js"
        )).href);
        await archiveModule.createArtifactDirectoryArchive(extensionDirectory, extensionAsset);
        await archiveModule.createArtifactDirectoryArchive(providerDirectory, providerAsset);
        await Promise.all([
            writeSha256(extensionAsset),
            writeSha256(providerAsset)
        ]);
        return {
            extensionAsset,
            providerAsset,
            target
        };
    } finally {
        await rm(stagingRoot, { force: true, recursive: true });
    }
}

export async function sanitizeDeployTree(root) {
    await Promise.all([
        rm(join(root, "node_modules", ".bin"), { force: true, recursive: true }),
        rm(join(root, "node_modules", ".pnpm"), { force: true, recursive: true }),
        rm(join(root, "node_modules", ".modules.yaml"), { force: true }),
        rm(join(root, "node_modules", ".pnpm-workspace-state-v1.json"), { force: true }),
        rm(join(root, "pnpm-lock.yaml"), { force: true })
    ]);
}

export async function shapeThinAgentExtensionTree(root) {
    await rm(join(root, "dist", "provider", "pi"), { force: true, recursive: true });
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
    const providerTree = join(root, ".pi-provider-dist");
    await rename(join(root, "dist", "provider", "pi"), providerTree);
    await rm(join(root, "dist"), { force: true, recursive: true });
    await mkdir(join(root, "dist", "provider"), { recursive: true });
    await rename(providerTree, join(root, "dist", "provider", "pi"));
    await copyFile(piProviderManifest, join(root, "devshell-agent-provider.json"));
    await rm(join(root, "devshell-extension.json"), { force: true });
    await rm(join(root, "node_modules", "@portable-devshell", "extension"), { force: true, recursive: true });
    await rewriteDeploymentPackage(root, {
        dependencies: {
            "@earendil-works/pi-coding-agent": "0.84.4",
            "@earendil-works/pi-tui": "0.84.4",
            "@portable-devshell/shared": "workspace:*",
            "diff": "8.0.4",
            "pi-gui-extension": "0.4.1"
        },
        entry: "./dist/provider/pi/index.js",
        name: "@portable-devshell-internal/agent-provider-pi",
        version: providerManifest.version
    });
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
        if (normalized === "dist/provider/pi" || normalized.startsWith("dist/provider/pi/")) {
            throw new Error(`Agent Extension payload must not contain Pi provider/runtime content: ${normalized}`);
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const result = await packageAgentArtifacts({
        outputDirectory: readOption(args, "--output-dir"),
        target: readOption(args, "--target")
    });
    process.stdout.write(`${result.extensionAsset}\n${result.extensionAsset}.sha256\n`);
    process.stdout.write(`${result.providerAsset}\n${result.providerAsset}.sha256\n`);
}
