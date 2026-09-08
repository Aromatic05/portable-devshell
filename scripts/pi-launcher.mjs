#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolveManagedPiRuntime(environment = process.env, homeDirectory = homedir()) {
    const dataHome = environment.XDG_DATA_HOME
        ?? (process.platform === "win32"
            ? environment.LOCALAPPDATA ?? resolve(homeDirectory, "AppData", "Local")
            : resolve(homeDirectory, ".local", "share"));
    const devshellHome = environment.PORTABLE_DEVSHELL_HOME ?? resolve(homeDirectory, ".devshell");
    const registryFile = resolve(devshellHome, "control", "extensions", "state", "agent", "providers.json");
    const registrySource = await readFile(registryFile, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
    });
    const registry = registrySource === undefined ? undefined : JSON.parse(registrySource);
    const entry = registry?.schemaVersion === 1 ? registry.providers?.pi : undefined;
    if (
        typeof entry !== "object"
        || entry === null
        || entry.enabled !== true
        || typeof entry.selectedGeneration !== "string"
        || entry.selectedGeneration.length === 0
    ) {
        throw new Error(
            "The Pi provider is not installed and enabled. Run `devshell agent provider install <pi.dsprovider>` first."
        );
    }
    assertSafeGeneration(entry.selectedGeneration);
    const providerDirectory = resolve(
        dataHome,
        "portable-devshell",
        "extension-data",
        "agent",
        "bundles",
        entry.selectedGeneration
    );
    await assertPlainDirectory(providerDirectory, "Pi provider generation");

    const piPackageRoot = resolve(providerDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
    const piPackage = JSON.parse(await readFile(resolve(piPackageRoot, "package.json"), "utf8"));
    const piBin = typeof piPackage.bin === "string" ? piPackage.bin : piPackage.bin?.pi;
    if (typeof piBin !== "string" || piBin.length === 0) {
        throw new Error("Installed Pi provider does not expose a pi CLI entrypoint.");
    }
    const piEntrypoint = resolveContainedFile(piPackageRoot, piBin, "Pi CLI entrypoint");

    const extensionEntrypoint = resolveContainedFile(
        providerDirectory,
        "dist/provider/pi/extension/index.js",
        "Pi extension entrypoint"
    );
    await Promise.all([
        assertPlainFile(piEntrypoint, "Pi CLI entrypoint"),
        assertPlainFile(extensionEntrypoint, "Pi extension entrypoint")
    ]);

    return {
        devshellHome,
        extensionEntrypoint,
        piEntrypoint,
        providerDirectory,
        selectedGeneration: entry.selectedGeneration
    };
}

export async function launchManagedPi(argv = process.argv.slice(2), environment = process.env) {
    const launchWorkspace = process.cwd();
    const runtime = await resolveManagedPiRuntime(environment);
    environment.PORTABLE_DEVSHELL_PI_WORKSPACE = launchWorkspace;
    const targetIdentity = environment.DEVSHELL_AGENT_TARGET ?? launchWorkspace;
    const workspaceIdentity = createHash("sha256").update(targetIdentity).digest("hex").slice(0, 16);
    const runtimeWorkspace = resolve(runtime.devshellHome, "pi", "workspaces", workspaceIdentity);
    await mkdir(runtimeWorkspace, { mode: 0o700, recursive: true });
    process.chdir(runtimeWorkspace);

    const forwarded = [...argv];
    if (
        environment.DEVSHELL_PI_BUILTIN_TOOLS !== "1"
        && !forwarded.includes("--no-builtin-tools")
        && !forwarded.includes("-nbt")
    ) {
        forwarded.unshift("--no-builtin-tools");
    }
    forwarded.unshift("--extension", runtime.extensionEntrypoint);
    process.argv = [process.argv[0] ?? process.execPath, runtime.piEntrypoint, ...forwarded];
    await import(pathToFileURL(runtime.piEntrypoint).href);
}

function resolveContainedFile(root, candidate, label) {
    if (isAbsolute(candidate)) throw new Error(`${label} must be relative to its package root.`);
    const absolute = resolve(root, candidate);
    const child = relative(root, absolute);
    if (child === "" || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
        throw new Error(`${label} escapes its package root.`);
    }
    return absolute;
}

function assertSafeGeneration(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
        throw new Error("Selected Pi provider generation is invalid.");
    }
}

async function assertPlainDirectory(path, label) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a plain directory.`);
}

async function assertPlainFile(path, label) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a plain file.`);
}

function isEntrypoint() {
    const candidate = process.argv[1];
    if (candidate === undefined) return false;
    try {
        return realpathSync(candidate) === realpathSync(new URL(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntrypoint()) {
    await launchManagedPi().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
