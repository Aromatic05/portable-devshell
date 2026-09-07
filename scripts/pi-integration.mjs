import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    symlink,
    writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANAGED_PI_LAUNCHER_MARKER = "portable-devshell managed Pi launcher";
const MANAGED_PI_EXTENSION_MARKER = "portable-devshell managed Pi extension loader";

export function resolvePiIntegrationPaths({ binDirectory, home, platform = process.platform }) {
    const command = resolve(binDirectory, platform === "win32" ? "pi.cmd" : "pi");
    const launcher = platform === "win32"
        ? resolve(binDirectory, ".portable-devshell-pi.mjs")
        : command;
    return {
        command,
        extension: resolve(home, ".pi", "agent", "extensions", "devshell.js"),
        launcher
    };
}

export async function resolvePiDeploymentTargets(currentLink) {
    const controlEntry = await realpath(resolve(
        currentLink,
        "node_modules",
        "@portable-devshell",
        "control",
        "dist",
        "index.js"
    ));
    const agentdRoot = await findDependencyPackageRoot(controlEntry, "@portable-devshell/agentd");
    const agentdEntry = resolve(agentdRoot, "dist", "index.js");
    await assertRegularFile(agentdEntry, "portable-devshell Agent runtime");

    const extensionRoot = await findDependencyPackageRoot(agentdEntry, "@portable-devshell/pi-extension");
    const piRoot = await findDependencyPackageRoot(agentdEntry, "@earendil-works/pi-coding-agent");
    const extensionPackage = await readPackageJson(extensionRoot);
    const piPackage = await readPackageJson(piRoot);
    const piBin = typeof piPackage.bin === "string" ? piPackage.bin : piPackage.bin?.pi;
    if (typeof piBin !== "string" || piBin.length === 0) {
        throw new Error("Bundled Pi package does not declare bin.pi.");
    }
    if (typeof extensionPackage.main !== "string" || extensionPackage.main.length === 0) {
        throw new Error("portable-devshell Pi extension does not declare a package main entry.");
    }
    return {
        extensionTarget: resolvePackageEntry(extensionRoot, extensionPackage.main, "Pi extension main"),
        piTarget: resolvePackageEntry(piRoot, piBin, "Pi CLI bin")
    };
}

export async function activatePiIntegration(options) {
    const platform = options.platform ?? process.platform;
    const paths = resolvePiIntegrationPaths({ ...options, platform });
    const targets = await resolvePiDeploymentTargets(options.currentLink);
    await assertRegularFile(targets.piTarget, "bundled Pi CLI");
    await assertRegularFile(targets.extensionTarget, "portable-devshell Pi extension");
    await mkdir(dirname(paths.command), { recursive: true });
    await mkdir(dirname(paths.extension), { recursive: true });

    const piUrl = pathToFileURL(targets.piTarget).href;
    const launcher = [
        "#!/usr/bin/env node",
        `// ${MANAGED_PI_LAUNCHER_MARKER}`,
        'const managementCommands = new Set(["auth", "config", "install", "list", "remove", "uninstall", "update"]);',
        "const originalArguments = process.argv.slice(2);",
        'const separatorIndex = originalArguments.indexOf("--");',
        "const optionArguments = separatorIndex < 0 ? originalArguments : originalArguments.slice(0, separatorIndex);",
        'const metadataInvocation = optionArguments.some((argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v");',
        "const runtimeInvocation = !managementCommands.has(originalArguments[0]) && !metadataInvocation;",
        "const projectWorkspace = process.cwd();",
        "if (runtimeInvocation) {",
        "    process.env.PORTABLE_DEVSHELL_PI_WORKSPACE = projectWorkspace;",
        "    if (process.env.DEVSHELL_PI_BUILTIN_TOOLS !== \"1\" && !process.argv.includes(\"--no-builtin-tools\") && !process.argv.includes(\"-nbt\")) {",
        "        process.argv.splice(2, 0, \"--no-builtin-tools\");",
        "    }",
        '    const messageSeparatorIndex = process.argv.indexOf("--", 2);',
        '    process.argv.splice(messageSeparatorIndex < 0 ? process.argv.length : messageSeparatorIndex, 0, "--no-approve");',
        "}",
        `await import(${JSON.stringify(piUrl)});`,
        ""
    ].join("\n");
    await writeAtomicFile(paths.launcher, launcher, 0o755);
    if (platform !== "win32") await chmod(paths.launcher, 0o755);

    if (platform === "win32") {
        await writeAtomicFile(
            paths.command,
            `@echo off\r\nREM ${MANAGED_PI_LAUNCHER_MARKER}\r\nnode "${paths.launcher}" %*\r\n`
        );
    }

    const extensionUrl = pathToFileURL(targets.extensionTarget).href;
    await writeAtomicFile(
        paths.extension,
        `// ${MANAGED_PI_EXTENSION_MARKER}\nexport { default } from ${JSON.stringify(extensionUrl)};\nexport * from ${JSON.stringify(extensionUrl)};\n`
    );
    return { ...paths, ...targets };
}

export async function capturePiIntegration(options) {
    const paths = resolvePiIntegrationPaths(options);
    return {
        command: await capturePath(paths.command),
        extension: await capturePath(paths.extension),
        ...(paths.launcher === paths.command ? {} : { launcher: await capturePath(paths.launcher) }),
        paths
    };
}

export async function restorePiIntegration(snapshot) {
    await restorePath(snapshot.paths.command, snapshot.command);
    await restorePath(snapshot.paths.extension, snapshot.extension);
    if (snapshot.paths.launcher !== snapshot.paths.command) {
        await restorePath(snapshot.paths.launcher, snapshot.launcher);
    }
}

export async function writePiIntegrationSnapshot(snapshotPath, options) {
    const snapshot = await capturePiIntegration(options);
    await writeFile(snapshotPath, `${JSON.stringify(encodeSnapshot(snapshot), null, 2)}\n`, "utf8");
}

export async function restorePiIntegrationSnapshot(snapshotPath) {
    await restorePiIntegration(await readPiIntegrationSnapshot(snapshotPath));
}

export async function persistOriginalPiIntegrationSnapshot(snapshotPath, snapshot, platform = process.platform) {
    const original = normalizeOriginalPiIntegration(snapshot, platform);
    await mkdir(dirname(snapshotPath), { recursive: true });
    const content = `${JSON.stringify(encodeSnapshot(original), null, 2)}\n`;
    try {
        await writeFile(snapshotPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return true;
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await readPiIntegrationSnapshot(snapshotPath);
        return false;
    }
}

export async function persistOriginalPiIntegrationSnapshotFile(
    sourceSnapshotPath,
    originalSnapshotPath,
    platform = process.platform
) {
    return await persistOriginalPiIntegrationSnapshot(
        originalSnapshotPath,
        await readPiIntegrationSnapshot(sourceSnapshotPath),
        platform
    );
}

export async function deactivatePiIntegration(originalSnapshotPath, options) {
    const platform = options.platform ?? process.platform;
    const current = await capturePiIntegration({ ...options, platform });
    try {
        const original = await readPiIntegrationSnapshot(originalSnapshotPath);
        await restoreOriginalPathIfManaged(
            current.paths.command,
            current.command,
            original.command,
            "command",
            platform
        );
        await restoreOriginalPathIfManaged(
            current.paths.extension,
            current.extension,
            original.extension,
            "extension",
            platform
        );
        if (current.paths.launcher !== current.paths.command) {
            await restoreOriginalPathIfManaged(
                current.paths.launcher,
                current.launcher,
                original.launcher,
                "launcher",
                platform
            );
        }
        return { restoredOriginal: true };
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }

    await removeManagedPath(current.paths.command, current.command, "command", platform);
    await removeManagedPath(current.paths.extension, current.extension, "extension", platform);
    if (current.paths.launcher !== current.paths.command) {
        await removeManagedPath(current.paths.launcher, current.launcher, "launcher", platform);
    }
    return { restoredOriginal: false };
}

async function readPiIntegrationSnapshot(snapshotPath) {
    const encoded = JSON.parse(await readFile(snapshotPath, "utf8"));
    return decodeSnapshot(encoded);
}

async function capturePath(path) {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            return { kind: "symlink", target: await readlink(path) };
        }
        if (stat.isFile()) {
            return { content: await readFile(path), kind: "file", mode: stat.mode & 0o777 };
        }
        throw new Error(`Refusing to replace non-file Pi integration path: ${path}`);
    } catch (error) {
        if (error?.code === "ENOENT") return { kind: "missing" };
        throw error;
    }
}

async function restorePath(path, snapshot) {
    await rm(path, { force: true });
    if (snapshot === undefined || snapshot.kind === "missing") return;
    await mkdir(dirname(path), { recursive: true });
    if (snapshot.kind === "symlink") {
        await symlink(snapshot.target, path);
        return;
    }
    await writeFile(path, snapshot.content, { mode: snapshot.mode });
}

function normalizeOriginalPiIntegration(snapshot, platform) {
    return {
        ...snapshot,
        command: normalizeOriginalPath(snapshot.command, "command", platform),
        extension: normalizeOriginalPath(snapshot.extension, "extension", platform),
        ...(snapshot.launcher === undefined
            ? {}
            : { launcher: normalizeOriginalPath(snapshot.launcher, "launcher", platform) })
    };
}

function normalizeOriginalPath(snapshot, role, platform) {
    return isManagedPiPath(snapshot, role, platform) ? { kind: "missing" } : snapshot;
}

async function removeManagedPath(path, snapshot, role, platform) {
    if (isManagedPiPath(snapshot, role, platform)) await rm(path, { force: true });
}

async function restoreOriginalPathIfManaged(path, current, original, role, platform) {
    if (current?.kind !== "missing" && !isManagedPiPath(current, role, platform)) return;
    await restorePath(path, original);
}

function isManagedPiPath(snapshot, role, platform) {
    if (snapshot?.kind !== "file") return false;
    const content = snapshot.content.toString("utf8");
    if (role === "extension") {
        return content.includes(MANAGED_PI_EXTENSION_MARKER)
            || (content.includes("export { default } from ")
                && content.includes("export * from ")
                && content.includes("pi-extension"));
    }
    if (role === "command" && platform === "win32") {
        return content.includes(MANAGED_PI_LAUNCHER_MARKER)
            || (content.includes(".portable-devshell-pi.mjs") && content.includes("%*"));
    }
    return content.includes(MANAGED_PI_LAUNCHER_MARKER)
        || (content.includes("DEVSHELL_PI_BUILTIN_TOOLS")
            && content.includes("--no-builtin-tools")
            && content.includes("pi-coding-agent"));
}

async function findDependencyPackageRoot(fromFile, packageName) {
    let current = dirname(await realpath(fromFile));
    while (true) {
        const candidate = basename(current) === "node_modules"
            ? resolve(current, packageName)
            : resolve(current, "node_modules", packageName);
        try {
            const packagePath = resolve(candidate, "package.json");
            const stat = await lstat(packagePath);
            if (stat.isFile()) return await realpath(candidate);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    throw new Error(`Cannot resolve deployed dependency ${packageName} from ${fromFile}.`);
}

async function readPackageJson(packageRoot) {
    return JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
}

function resolvePackageEntry(packageRoot, entry, label) {
    const target = resolve(packageRoot, entry);
    const local = relative(packageRoot, target);
    if (local === "" || local.startsWith("..") || isAbsolute(local)) {
        throw new Error(`${label} escapes its package root: ${entry}`);
    }
    return target;
}

async function assertRegularFile(path, label) {
    try {
        const stat = await lstat(path);
        if (stat.isFile()) return;
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    throw new Error(`${label} is missing from the portable-devshell deployment: ${path}`);
}

async function writeAtomicFile(path, content, mode = 0o644) {
    const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await writeFile(temporary, content, { mode });
    try {
        await rename(temporary, path);
    } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await rm(path, { force: true });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

function encodeSnapshot(snapshot) {
    return {
        ...snapshot,
        command: encodePathSnapshot(snapshot.command),
        extension: encodePathSnapshot(snapshot.extension),
        ...(snapshot.launcher === undefined ? {} : { launcher: encodePathSnapshot(snapshot.launcher) })
    };
}

function decodeSnapshot(snapshot) {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw new Error("Invalid Pi integration snapshot.");
    }
    return {
        ...snapshot,
        command: decodePathSnapshot(snapshot.command),
        extension: decodePathSnapshot(snapshot.extension),
        ...(snapshot.launcher === undefined ? {} : { launcher: decodePathSnapshot(snapshot.launcher) })
    };
}

function encodePathSnapshot(snapshot) {
    if (snapshot?.kind !== "file") return snapshot;
    return { ...snapshot, content: snapshot.content.toString("base64") };
}

function decodePathSnapshot(snapshot) {
    if (snapshot?.kind !== "file") return snapshot;
    if (typeof snapshot.content !== "string") throw new Error("Invalid Pi integration file snapshot.");
    return { ...snapshot, content: Buffer.from(snapshot.content, "base64") };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "snapshot") {
        const [snapshotPath, binDirectory, home, platform] = args;
        if (snapshotPath === undefined || binDirectory === undefined || home === undefined) {
            throw new Error("usage: pi-integration.mjs snapshot <snapshot> <bin-directory> <home> [platform]");
        }
        await writePiIntegrationSnapshot(snapshotPath, {
            binDirectory,
            home,
            ...(platform === undefined ? {} : { platform })
        });
    } else if (mode === "activate") {
        const [binDirectory, currentLink, home, platform] = args;
        if (binDirectory === undefined || currentLink === undefined || home === undefined) {
            throw new Error("usage: pi-integration.mjs activate <bin-directory> <current-link> <home> [platform]");
        }
        await activatePiIntegration({
            binDirectory,
            currentLink,
            home,
            ...(platform === undefined ? {} : { platform })
        });
    } else if (mode === "restore") {
        const [snapshotPath] = args;
        if (snapshotPath === undefined) throw new Error("usage: pi-integration.mjs restore <snapshot>");
        await restorePiIntegrationSnapshot(snapshotPath);
    } else if (mode === "persist-original") {
        const [sourceSnapshotPath, originalSnapshotPath, platform] = args;
        if (sourceSnapshotPath === undefined || originalSnapshotPath === undefined) {
            throw new Error("usage: pi-integration.mjs persist-original <source-snapshot> <original-snapshot> [platform]");
        }
        await persistOriginalPiIntegrationSnapshotFile(
            sourceSnapshotPath,
            originalSnapshotPath,
            platform ?? process.platform
        );
    } else if (mode === "deactivate") {
        const [originalSnapshotPath, binDirectory, home, platform] = args;
        if (originalSnapshotPath === undefined || binDirectory === undefined || home === undefined) {
            throw new Error("usage: pi-integration.mjs deactivate <original-snapshot> <bin-directory> <home> [platform]");
        }
        await deactivatePiIntegration(originalSnapshotPath, {
            binDirectory,
            home,
            ...(platform === undefined ? {} : { platform })
        });
    } else {
        throw new Error("usage: pi-integration.mjs <snapshot|activate|restore|persist-original|deactivate> ...");
    }
}
