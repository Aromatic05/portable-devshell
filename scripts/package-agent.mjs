import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
        buildWorkspacePackage("@portable-devshell/agent-provider-pi");
        buildWorkspacePackage("@portable-devshell/control");
        deployWorkspacePackage("@portable-devshell/agent-extension", extensionDirectory);
        deployWorkspacePackage("@portable-devshell/agent-provider-pi", providerDirectory);
        await Promise.all([
            sanitizeDeployTree(extensionDirectory),
            sanitizeDeployTree(providerDirectory)
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

export async function assertNoSymbolicLinks(root) {
    await walk(root, async (path, relativePath, metadata) => {
        if (metadata.isSymbolicLink()) {
            throw new Error(`packaged Agent artifact contains symbolic link: ${relativePath}`);
        }
    });
}

export async function assertThinAgentExtensionTree(root) {
    const forbidden = [
        "node_modules/@portable-devshell/agent-provider-pi",
        "node_modules/@portable-devshell/pi-extension",
        "node_modules/pi-gui-extension"
    ];
    await walk(root, async (_path, relativePath) => {
        const normalized = relativePath.replaceAll("\\", "/");
        if (
            forbidden.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
            || normalized.startsWith("node_modules/@earendil-works/pi-")
        ) {
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
