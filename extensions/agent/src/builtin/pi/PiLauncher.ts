import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PROVIDER_ID = "pi";

interface PiProviderRegistryEntry {
    enabled?: unknown;
    lastKnownGoodGeneration?: unknown;
    selectedGeneration?: unknown;
}

interface PiProviderManifest {
    id?: unknown;
    version?: unknown;
}

interface PiProviderRuntimePaths {
    agentDirectory: string;
    cacheDirectory: string;
    installationDirectory: string;
    prefixDirectory: string;
    providerDirectory: string;
    stateDirectory: string;
}

interface PiManagedInstallation {
    agentDirectory: string;
    entrypoint: string;
    managedInstallRoot: string;
    packageRoot: string;
}

interface PiProviderInstallerModule {
    PI_BOOTSTRAP_VERSION: string;
    PiProviderInstaller: new (options: { version: string }) => {
        ensureInstalled(
            runtime: PiProviderRuntimePaths,
        ): Promise<PiManagedInstallation>;
    };
}

export interface InstalledPiRuntime {
    devshellHome: string;
    extensionEntrypoint: string;
    installation: PiManagedInstallation;
    piEntrypoint: string;
    providerDirectory: string;
    selectedGeneration: string;
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
        registry.schemaVersion === 1
            ? registry.providers?.[PI_PROVIDER_ID]
            : undefined;
    if (entry === undefined || entry.enabled !== true) {
        throw new Error(
            "The bundled Pi provider is not installed and enabled. Reinstall or enable the Agent Pi provider first.",
        );
    }
    const selectedGeneration = readGeneration(
        entry.selectedGeneration ?? entry.lastKnownGoodGeneration,
    );
    const providerDirectory = resolve(
        dataHome,
        "portable-devshell",
        "extension-data",
        "agent",
        "bundles",
        selectedGeneration,
    );
    await assertPlainDirectory(providerDirectory, "Pi provider generation");
    const manifest = JSON.parse(
        await readFile(
            resolve(providerDirectory, "devshell-agent-provider.json"),
            "utf8",
        ),
    ) as PiProviderManifest;
    if (
        manifest.id !== PI_PROVIDER_ID ||
        typeof manifest.version !== "string" ||
        manifest.version.length === 0
    ) {
        throw new Error(
            "Selected Agent provider generation is not a valid Pi provider.",
        );
    }

    const providerRuntimeDirectory = resolve(
        agentStateDirectory,
        "providers",
        PI_PROVIDER_ID,
    );
    const runtime: PiProviderRuntimePaths = {
        agentDirectory: agentStateDirectory,
        cacheDirectory: resolve(providerRuntimeDirectory, "cache"),
        installationDirectory: resolve(providerRuntimeDirectory, "install"),
        prefixDirectory: resolve(
            providerRuntimeDirectory,
            "prefix",
            manifest.version,
        ),
        providerDirectory: providerRuntimeDirectory,
        stateDirectory: resolve(providerRuntimeDirectory, "state"),
    };
    const installerEntrypoint = resolve(
        providerDirectory,
        "dist",
        "provider",
        "pi",
        "PiProviderInstaller.js",
    );
    await assertPlainFile(installerEntrypoint, "Pi provider installer");
    const installerModule = (await import(
        pathToFileURL(installerEntrypoint).href
    )) as Partial<PiProviderInstallerModule>;
    if (
        typeof installerModule.PiProviderInstaller !== "function" ||
        typeof installerModule.PI_BOOTSTRAP_VERSION !== "string"
    ) {
        throw new Error(
            "Installed Pi provider does not expose its bootstrap installer.",
        );
    }
    const installation = await new installerModule.PiProviderInstaller({
        version: installerModule.PI_BOOTSTRAP_VERSION,
    }).ensureInstalled(runtime);
    const piEntrypoint = await resolvePiCliEntrypoint(installation.packageRoot);
    const extensionEntrypoint = resolve(
        providerDirectory,
        "dist",
        "provider",
        "pi",
        "extension",
        "index.js",
    );
    await assertPlainFile(
        extensionEntrypoint,
        "Pi DevShell extension entrypoint",
    );
    return {
        devshellHome,
        extensionEntrypoint,
        installation,
        piEntrypoint,
        providerDirectory,
        selectedGeneration,
    };
}

export async function launchInstalledPi(
    argv: readonly string[] = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = homedir(),
): Promise<void> {
    const launchWorkspace = process.cwd();
    const runtime = await resolveInstalledPiRuntime(environment, homeDirectory);
    environment.PORTABLE_DEVSHELL_PI_WORKSPACE = launchWorkspace;
    environment.PI_MANAGED_INSTALL_ROOT =
        runtime.installation.managedInstallRoot;

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
    if (isAbsolute(candidate))
        throw new Error(`${label} must be relative to its package root.`);
    const absolute = resolve(root, candidate);
    const child = relative(root, absolute);
    if (
        child === "" ||
        child === ".." ||
        child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(child)
    ) {
        throw new Error(`${label} escapes its package root.`);
    }
    return absolute;
}

function readGeneration(value: unknown): string {
    if (typeof value !== "string" || !/^sha256-[0-9a-f]{64}$/u.test(value)) {
        throw new Error("The selected Pi provider generation is invalid.");
    }
    return value;
}

async function assertPlainDirectory(
    path: string,
    label: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new Error(`${label} must be a plain directory.`);
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile())
        throw new Error(`${label} must be a plain file.`);
}
