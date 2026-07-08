import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { waitForCommandResult } from "../command/WorkerCommandTransport.js";
import { WorkerAssetResolver } from "../WorkerAssetResolver.js";

export interface RemoteWorkerInstallerOptions {
    resolver?: WorkerAssetResolver;
    spawnShell: (commandLine: string, stdio: ["ignore" | "pipe", "pipe", "pipe"]) => ChildProcess;
    createProviderError: (operation: string, cause: unknown) => Error;
}

export class RemoteWorkerInstaller {
    readonly #resolver: WorkerAssetResolver;
    readonly #spawnShell: RemoteWorkerInstallerOptions["spawnShell"];
    readonly #createProviderError: RemoteWorkerInstallerOptions["createProviderError"];
    #installPromise?: Promise<string>;

    constructor(options: RemoteWorkerInstallerOptions) {
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#spawnShell = options.spawnShell;
        this.#createProviderError = options.createProviderError;
    }

    async ensure(executable: string): Promise<string> {
        if (executable !== "devshell-worker") {
            return executable;
        }

        if (this.#installPromise === undefined) {
            this.#installPromise = this.#installDefaultWorker().catch((error) => {
                this.#installPromise = undefined;
                throw error;
            });
        }

        return await this.#installPromise;
    }

    async #installDefaultWorker(): Promise<string> {
        const asset = await this.#resolver.resolve().catch((error) => {
            throw this.#createProviderError("resolveExecutable", error);
        });
        const homeDirectory = await this.#resolveHomeDirectory();
        const binary = await readFile(asset.binaryPath).catch((error) => {
            throw this.#createProviderError("resolveExecutable", error);
        });
        const child = this.#spawnShell(buildInstallScript(homeDirectory, asset.sha256), ["pipe", "pipe", "pipe"]);

        await writeToChildStdin(child, binary, this.#createProviderError, "installWorker");

        const result = await waitForCommandResult(child, this.#createProviderError, "installWorker");
        if (result.exitCode !== 0) {
            throw this.#createProviderError("installWorker", new Error(result.stderr || result.stdout || "worker install failed"));
        }

        return buildRemoteExecutablePath(homeDirectory);
    }

    async #resolveHomeDirectory(): Promise<string> {
        const child = this.#spawnShell('printf %s "${HOME:?HOME is required to install the worker}"', ["ignore", "pipe", "pipe"]);
        const result = await waitForCommandResult(child, this.#createProviderError, "resolveExecutable");

        if (result.exitCode !== 0) {
            throw this.#createProviderError("resolveExecutable", new Error(result.stderr || result.stdout || "failed to resolve HOME"));
        }

        const homeDirectory = result.stdout.trim();
        if (homeDirectory.length === 0) {
            throw this.#createProviderError("resolveExecutable", new Error("HOME is required to install the worker"));
        }

        return homeDirectory;
    }
}

function buildInstallScript(homeDirectory: string, sha256: string): string {
    const installDirectory = `${homeDirectory}/.devshell/workers/${sha256}`;
    const binaryPath = `${installDirectory}/devshell-worker`;
    const shaPath = `${installDirectory}/devshell-worker.sha256`;
    const symlinkPath = buildRemoteExecutablePath(homeDirectory);
    const symlinkTarget = `../workers/${sha256}/devshell-worker`;

    return [
        "set -eu",
        `install_dir=${shellEscape(installDirectory)}`,
        `binary_path=${shellEscape(binaryPath)}`,
        `sha_path=${shellEscape(shaPath)}`,
        `symlink_path=${shellEscape(symlinkPath)}`,
        `symlink_target=${shellEscape(symlinkTarget)}`,
        `expected_sha=${shellEscape(sha256)}`,
        'mkdir -p "$install_dir" "$(dirname "$symlink_path")"',
        'installed_sha=""',
        'if [ -f "$sha_path" ]; then',
        '  installed_sha="$(cat "$sha_path")"',
        "fi",
        'if [ "$installed_sha" = "$expected_sha" ] && [ -f "$binary_path" ]; then',
        "  cat >/dev/null",
        "else",
        '  cat > "$binary_path.tmp"',
        '  chmod 755 "$binary_path.tmp"',
        '  printf \'%s\\n\' "$expected_sha" > "$sha_path.tmp"',
        '  mv "$binary_path.tmp" "$binary_path"',
        '  mv "$sha_path.tmp" "$sha_path"',
        "fi",
        'ln -snf "$symlink_target" "$symlink_path"'
    ].join("\n");
}

function buildRemoteExecutablePath(homeDirectory: string): string {
    return `${homeDirectory}/.devshell/bin/devshell-worker`;
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeToChildStdin(
    child: ChildProcess,
    bytes: Buffer,
    createError: (operation: string, cause: unknown) => Error,
    operation: string
): Promise<void> {
    const stdin = child.stdin;

    if (stdin === null) {
        throw createError(operation, new Error("worker install stdin is unavailable"));
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            stdin.off("finish", onFinish);
            reject(createError(operation, error));
        };
        const onFinish = () => {
            stdin.off("error", onError);
            resolve();
        };

        stdin.once("error", onError);
        stdin.once("finish", onFinish);
        stdin.end(bytes);
    });
}
