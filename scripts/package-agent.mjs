import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Build the platform-neutral Agent Extension archive used for local development
 * and Extension distribution. Core release CI does not publish this artifact.
 */
export async function packageAgentArtifacts(options = {}) {
    const outputDirectory = resolve(
        repoRoot,
        options.outputDirectory ?? "release-assets",
    );
    const stagingRoot = await mkdtemp(
        resolve(repoRoot, ".portable-devshell-agent-"),
    );
    const extensionDirectory = resolve(stagingRoot, "agent-extension");
    const extensionAsset = resolve(
        outputDirectory,
        "portable-devshell-agent.dsext",
    );

    try {
        await mkdir(outputDirectory, { recursive: true });
        buildWorkspacePackage("@portable-devshell/agent-extension");
        buildWorkspacePackage("@portable-devshell/control");
        deployWorkspacePackage(
            "@portable-devshell/agent-extension",
            extensionDirectory,
        );
        await sanitizeDeployTree(extensionDirectory);
        await shapeThinAgentExtensionTree(extensionDirectory);
        await Promise.all([
            assertNoSymbolicLinks(extensionDirectory),
            assertThinAgentExtensionTree(extensionDirectory),
        ]);

        await rm(extensionAsset, { force: true });
        const archiveModule = await import(
            pathToFileURL(
                resolve(
                    repoRoot,
                    "packages/control/dist/control/artifact/host/storage/Archive.js",
                ),
            ).href
        );
        await archiveModule.createArtifactDirectoryArchive(
            extensionDirectory,
            extensionAsset,
        );
        await writeSha256(extensionAsset);
        return { extensionAsset };
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
        if (
            insideNodeModules &&
            entry.isDirectory() &&
            (entry.name === ".bin" || entry.name === ".pnpm")
        ) {
            await rm(path, { force: true, recursive: true });
            continue;
        }
        if (
            insideNodeModules &&
            entry.isFile() &&
            (entry.name === ".modules.yaml" ||
                entry.name === ".pnpm-workspace-state-v1.json")
        ) {
            await rm(path, { force: true });
            continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await removeNodeModulesDeploymentMetadata(path);
        }
    }
}

/**
 * Keep provider adapter code in the Extension, but never package dependency
 * trees. Provider runtime dependencies are installed on the client.
 */
export async function shapeThinAgentExtensionTree(root) {
    const builtinManifest = JSON.parse(
        await readFile(join(root, "devshell-extension.json"), "utf8"),
    );
    await rm(join(root, "node_modules"), { force: true, recursive: true });
    await rewriteDeploymentPackage(root, {
        dependencies: {},
        entry: "./dist/index.js",
        name: "@portable-devshell/agent-extension",
        version: builtinManifest.version,
    });
}

export async function assertNoSymbolicLinks(root) {
    await walk(root, async (_path, relativePath, metadata) => {
        if (metadata.isSymbolicLink()) {
            throw new Error(
                `packaged Agent artifact contains symbolic link: ${relativePath}`,
            );
        }
    });
}

export async function assertThinAgentExtensionTree(root) {
    await walk(root, async (_path, relativePath) => {
        const normalized = relativePath.replaceAll("\\", "/");
        if (
            normalized === "node_modules" ||
            normalized.startsWith("node_modules/")
        ) {
            throw new Error(
                `Agent Extension payload must not contain private node_modules: ${normalized}`,
            );
        }
        if (
            normalized === "bundled-providers" ||
            normalized.startsWith("bundled-providers/")
        ) {
            throw new Error(
                `Agent Extension payload must not contain bundled Provider artifacts: ${normalized}`,
            );
        }
    });
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
            default: manifest.main,
        },
    };
    manifest.dependencies = options.dependencies;
    delete manifest.devDependencies;
    delete manifest.files;
    delete manifest.publishConfig;
    delete manifest.scripts;
    await writeFile(path, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
}

async function walk(root, visit) {
    const descend = async (directory, prefix) => {
        const names = await readdir(directory);
        names.sort();
        for (const name of names) {
            const path = join(directory, name);
            const relativePath =
                prefix.length === 0 ? name : `${prefix}/${name}`;
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
    runPnpm([
        "-r",
        "--workspace-concurrency=1",
        "--filter",
        `${name}...`,
        "build",
    ]);
}

function deployWorkspacePackage(name, targetDirectory) {
    runPnpm([
        "--config.node-linker=hoisted",
        "--filter",
        name,
        "--prod",
        "deploy",
        "--legacy",
        relative(repoRoot, targetDirectory),
    ]);
}

function runPnpm(args) {
    const command = resolvePnpmCommand();
    const result = spawnSync(command.command, [...command.args, ...args], {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
    });
    if (result.status !== 0) {
        throw new Error(
            `pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        );
    }
}

async function writeSha256(path) {
    const content = await readFile(path);
    const digest = createHash("sha256").update(content).digest("hex");
    await writeFile(
        `${path}.sha256`,
        `${digest}  ${path.split(/[\\/]/u).at(-1)}\n`,
        "utf8",
    );
}

function readOption(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
        throw new Error(`${name} requires a value`);
    return value;
}

if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const args = process.argv.slice(2);
    const result = await packageAgentArtifacts({
        outputDirectory: readOption(args, "--output-dir"),
    });
    process.stdout.write(
        `${result.extensionAsset}\n${result.extensionAsset}.sha256\n`,
    );
}
