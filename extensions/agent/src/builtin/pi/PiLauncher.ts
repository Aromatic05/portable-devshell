import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentProviderRuntimePaths } from "../provider/AgentProviderRuntimePaths.js";
import { registerAgentProviderModuleResolver } from "../../provider/AgentProviderModuleResolver.js";
import {
    PI_PROVIDER_ID,
    PI_PROVIDER_VERSION,
} from "../../provider/pi/PiAgentProvider.js";
import {
    PI_BOOTSTRAP_VERSION,
    PiProviderInstaller,
    type PiProviderInstallation,
} from "../../provider/pi/PiProviderInstaller.js";

interface PiProviderRegistryEntry {
    enabled?: unknown;
}

export interface InstalledPiRuntime {
    coreModuleRoot: string;
    devshellHome: string;
    extensionEntrypoint: string;
    installation: PiProviderInstallation;
    piEntrypoint: string;
}

export async function resolveInstalledPiRuntime(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = homedir(),
): Promise<InstalledPiRuntime> {
    const dataHome =
        environment.XDG_DATA_HOME ??
        (process.platform === "win32"
            ? (environment.LOCALAPPDATA ??
              resolve(homeDirectory, "AppData", "Local"))
            : resolve(homeDirectory, ".local", "share"));
    const installRoot =
        environment.PORTABLE_DEVSHELL_INSTALL_ROOT ??
        resolve(dataHome, "portable-devshell");
    const coreModuleRoot = resolve(installRoot, "current");
    await readFile(resolve(coreModuleRoot, "package.json"), "utf8").catch(
        (error) => {
            throw new Error(
                "The installed DevShell application root is unavailable.",
                { cause: error },
            );
        },
    );

    const devshellHome =
        environment.PORTABLE_DEVSHELL_HOME ??
        resolve(homeDirectory, ".devshell");
    const agentStateDirectory = resolve(
        devshellHome,
        "control",
        "extensions",
        "state",
        "agent",
    );
    const registry = JSON.parse(
        await readFile(resolve(agentStateDirectory, "providers.json"), "utf8"),
    ) as {
        providers?: Record<string, PiProviderRegistryEntry>;
        schemaVersion?: unknown;
    };
    const entry =
        registry.schemaVersion === 1 || registry.schemaVersion === 2
            ? registry.providers?.[PI_PROVIDER_ID]
            : undefined;
    if (entry === undefined || entry.enabled !== true) {
        throw new Error(
            "The Pi Provider is not installed and enabled. Run devshell agent provider install pi or enable it first.",
        );
    }

    const runtime = new AgentProviderRuntimePaths({
        provider: PI_PROVIDER_ID,
        rootDirectory: agentStateDirectory,
        version: PI_PROVIDER_VERSION,
    });
    const installation = await new PiProviderInstaller({
        version: PI_BOOTSTRAP_VERSION,
    }).ensureInstalled(runtime);
    const piEntrypoint = await resolvePiCliEntrypoint(
        installation.packageRoot,
    );
    const source = fileURLToPath(import.meta.url);
    const extensionEntrypoint = resolve(
        dirname(source),
        source.endsWith(".ts")
            ? "../../provider/pi/extension/index.ts"
            : "../../provider/pi/extension/index.js",
    );
    await assertPlainFile(
        extensionEntrypoint,
        "Pi DevShell extension entrypoint",
    );
    return {
        coreModuleRoot,
        devshellHome,
        extensionEntrypoint,
        installation,
        piEntrypoint,
    };
}

export async function launchInstalledPi(
    argv: readonly string[] = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = homedir(),
): Promise<void> {
    const launchWorkspace = process.cwd();
    const runtime = await resolveInstalledPiRuntime(
        environment,
        homeDirectory,
    );
    environment.PORTABLE_DEVSHELL_PI_WORKSPACE = launchWorkspace;
    environment.PI_MANAGED_INSTALL_ROOT =
        runtime.installation.managedInstallRoot;

    registerAgentProviderModuleResolver(
        runtime.installation.moduleRoot,
        runtime.coreModuleRoot,
    );

    const forwarded = [...argv];
    if (
        environment.DEVSHELL_PI_BUILTIN_TOOLS !== "1" &&
        !forwarded.includes("--no-builtin-tools") &&
        !forwarded.includes("-nbt")
    ) {
        forwarded.unshift("--no-builtin-tools");
    }
    forwarded.unshift("--extension", runtime.extensionEntrypoint);
    process.argv = [
        process.argv[0] ?? process.execPath,
        runtime.piEntrypoint,
        ...forwarded,
    ];
    await import(pathToFileURL(runtime.piEntrypoint).href);
}

async function resolvePiCliEntrypoint(packageRoot: string): Promise<string> {
    const manifest = JSON.parse(
        await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
        bin?: string | Record<string, unknown>;
    };
    const candidate =
        typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof candidate !== "string" || candidate.length === 0) {
        throw new Error(
            "Managed Pi runtime does not expose a pi CLI entrypoint.",
        );
    }
    const entrypoint = resolveContainedFile(
        packageRoot,
        candidate,
        "Pi CLI entrypoint",
    );
    await assertPlainFile(entrypoint, "Pi CLI entrypoint");
    return entrypoint;
}

function resolveContainedFile(
    root: string,
    candidate: string,
    label: string,
): string {
    if (isAbsolute(candidate)) {
        throw new Error(label + " must be relative to its package root.");
    }
    const absolute = resolve(root, candidate);
    const child = relative(root, absolute);
    if (
        child === "" ||
        child === ".." ||
        child.startsWith(
            ".." + (process.platform === "win32" ? "\\" : "/"),
        ) ||
        isAbsolute(child)
    ) {
        throw new Error(label + " escapes its package root.");
    }
    return absolute;
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(label + " must be a plain file.");
    }
}
