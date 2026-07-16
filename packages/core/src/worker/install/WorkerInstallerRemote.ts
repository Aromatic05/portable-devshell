import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { ControlError, errorCodes, type ControlError as ControlErrorType } from "@portable-devshell/shared";

import type { ProviderCommandContext } from "../command/WorkerCommandTransport.js";
import { waitForCommandResult } from "../command/WorkerCommandTransport.js";
import { WorkerAssetResolver } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";

export interface WorkerInstallerRemoteOptions {
    resolver?: WorkerAssetResolver;
    probeTarget: () => Promise<WorkerTarget>;
    spawnShell: (
        commandLine: string,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        context: ProviderCommandContext
    ) => ChildProcess;
    createProviderError: (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => ControlErrorType;
    createContext: (operation: string, command: readonly string[]) => ProviderCommandContext;
}

export class WorkerInstallerRemote {
    readonly #resolver: WorkerAssetResolver;
    readonly #probeTarget: WorkerInstallerRemoteOptions["probeTarget"];
    readonly #spawnShell: WorkerInstallerRemoteOptions["spawnShell"];
    readonly #createProviderError: WorkerInstallerRemoteOptions["createProviderError"];
    readonly #createContext: WorkerInstallerRemoteOptions["createContext"];
    #installPromise?: Promise<string>;

    constructor(options: WorkerInstallerRemoteOptions) {
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#probeTarget = options.probeTarget;
        this.#spawnShell = options.spawnShell;
        this.#createProviderError = options.createProviderError;
        this.#createContext = options.createContext;
    }

    async ensure(executable: string): Promise<string> {
        if (executable !== "devshell-worker") {
            return executable;
        }

        if (this.#installPromise === undefined) {
            this.#installPromise = this.#installDefaultWorker().finally(() => {
                this.#installPromise = undefined;
            });
        }

        return await this.#installPromise;
    }

    async #installDefaultWorker(): Promise<string> {
        const target = await this.#probeTarget();
        const asset = await this.#resolver.resolve(target).catch((error) => {
            if (error instanceof ControlError) {
                throw error;
            }

            throw this.#createProviderError(this.#createContext("resolveExecutable", ["devshell-worker"]), error);
        });
        const homeDirectory = await this.#resolveHomeDirectory();

        if (await this.#isRemoteWorkerCurrent(homeDirectory, target.key, asset.sha256)) {
            return buildRemoteExecutablePath(homeDirectory);
        }

        const binary = await readFile(asset.binaryPath).catch((error) => {
            throw this.#createProviderError(this.#createContext("resolveExecutable", ["devshell-worker"]), error);
        });
        const commandLine = buildInstallScript(homeDirectory, target.key, asset.sha256);
        const context = this.#createContext("installWorker", ["sh", "-lc", commandLine]);
        const child = this.#spawnShell(commandLine, ["pipe", "pipe", "pipe"], context);

        await writeToChildStdin(child, binary, this.#createProviderError, context);

        const result = await waitForCommandResult(child, this.#createProviderError, context);
        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "worker install failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }

        return buildRemoteExecutablePath(homeDirectory);
    }

    async #isRemoteWorkerCurrent(homeDirectory: string, targetKey: string, sha256: string): Promise<boolean> {
        const commandLine = buildInspectScript(homeDirectory, targetKey, sha256);
        const context = this.#createContext("installWorker", ["sh", "-lc", commandLine]);
        const child = this.#spawnShell(commandLine, ["ignore", "pipe", "pipe"], context);
        const result = await waitForCommandResult(child, this.#createProviderError, context);

        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }

        const status = result.stdout.trim();
        if (status === "ready") {
            return true;
        }
        if (status === "missing") {
            return false;
        }

        throw this.#createProviderError(context, new Error(`unexpected worker install check result: ${status || "empty"}`), {
            errorCode: errorCodes.coreWorkerProvisionFailed,
            result
        });
    }

    async #resolveHomeDirectory(): Promise<string> {
        const commandLine = 'printf %s "${HOME:?HOME is required to install the worker}"';
        const context = this.#createContext("resolveExecutable", ["sh", "-lc", commandLine]);
        const child = this.#spawnShell(commandLine, ["ignore", "pipe", "pipe"], context);
        const result = await waitForCommandResult(child, this.#createProviderError, context);

        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "failed to resolve HOME"), { result });
        }

        const homeDirectory = result.stdout.trim();
        if (homeDirectory.length === 0) {
            throw this.#createProviderError(context, new Error("HOME is required to install the worker"), { result });
        }

        return homeDirectory;
    }
}

function buildInspectScript(homeDirectory: string, targetKey: string, sha256: string): string {
    const installDirectory = `${homeDirectory}/.devshell/workers/${targetKey}/${sha256}`;
    const binaryPath = `${installDirectory}/devshell-worker`;
    const shaPath = `${installDirectory}/devshell-worker.sha256`;
    const symlinkPath = buildRemoteExecutablePath(homeDirectory);
    const symlinkTarget = `../workers/${targetKey}/${sha256}/devshell-worker`;

    return [
        "set -eu",
        `binary_path=${shellEscape(binaryPath)}`,
        `sha_path=${shellEscape(shaPath)}`,
        `symlink_path=${shellEscape(symlinkPath)}`,
        `symlink_target=${shellEscape(symlinkTarget)}`,
        `expected_sha=${shellEscape(sha256)}`,
        'installed_sha=""',
        'if [ -f "$sha_path" ]; then',
        '  installed_sha="$(cat "$sha_path")"',
        "fi",
        'if [ "$installed_sha" = "$expected_sha" ] && [ -f "$binary_path" ]; then',
        '  mkdir -p "$(dirname "$symlink_path")"',
        '  ln -snf "$symlink_target" "$symlink_path"',
        "  printf '%s' ready",
        "else",
        "  printf '%s' missing",
        "fi"
    ].join("\n");
}

function buildInstallScript(homeDirectory: string, targetKey: string, sha256: string): string {
    const installDirectory = `${homeDirectory}/.devshell/workers/${targetKey}/${sha256}`;
    const binaryPath = `${installDirectory}/devshell-worker`;
    const shaPath = `${installDirectory}/devshell-worker.sha256`;
    const symlinkPath = buildRemoteExecutablePath(homeDirectory);
    const symlinkTarget = `../workers/${targetKey}/${sha256}/devshell-worker`;

    return [
        "set -eu",
        `install_dir=${shellEscape(installDirectory)}`,
        `binary_path=${shellEscape(binaryPath)}`,
        `sha_path=${shellEscape(shaPath)}`,
        `symlink_path=${shellEscape(symlinkPath)}`,
        `symlink_target=${shellEscape(symlinkTarget)}`,
        `expected_sha=${shellEscape(sha256)}`,
        'tmp_binary_path="${binary_path}.tmp.$$"',
        'tmp_sha_path="${sha_path}.tmp.$$"',
        'mkdir -p "$install_dir" "$(dirname "$symlink_path")"',
        'cat > "$tmp_binary_path"',
        'chmod 755 "$tmp_binary_path"',
        'printf \'%s\\n\' "$expected_sha" > "$tmp_sha_path"',
        'mv "$tmp_binary_path" "$binary_path"',
        'mv "$tmp_sha_path" "$sha_path"',
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
    createError: (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => Error,
    context: ProviderCommandContext
): Promise<void> {
    const stdin = child.stdin;

    if (stdin === null) {
        throw createError(context, new Error("worker install stdin is unavailable"), {
            errorCode: errorCodes.coreWorkerProvisionFailed
        });
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            stdin.off("finish", onFinish);
            reject(createError(context, error, { errorCode: errorCodes.coreWorkerProvisionFailed }));
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
