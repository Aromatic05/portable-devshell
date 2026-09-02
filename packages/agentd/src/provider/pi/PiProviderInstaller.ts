import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentProviderRuntimePaths } from "../../runtime/AgentProviderRuntimePaths.js";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiProviderInstallation {
    entrypoint: string;
    packageRoot: string;
    version: string;
}

export interface PiProviderInstallCommand {
    args: readonly string[];
    command: string;
    cwd: string;
}

export type PiProviderInstallRunner = (input: PiProviderInstallCommand) => Promise<void>;

export interface PiProviderInstallerOptions {
    npmCommand?: string;
    packageName?: string;
    runner?: PiProviderInstallRunner;
    version: string;
}

export class PiProviderInstaller {
    readonly #npmCommand: string;
    readonly #packageName: string;
    readonly #runner: PiProviderInstallRunner;
    readonly #version: string;
    #installing?: Promise<PiProviderInstallation>;

    constructor(options: PiProviderInstallerOptions) {
        this.#npmCommand = options.npmCommand ?? "npm";
        this.#packageName = options.packageName ?? PI_PACKAGE_NAME;
        this.#runner = options.runner ?? runInstallCommand;
        this.#version = options.version;
    }

    async ensureInstalled(runtime: AgentProviderRuntimePaths): Promise<PiProviderInstallation> {
        const existing = await this.#readInstallation(runtime);
        if (existing !== undefined) {
            return existing;
        }
        if (this.#installing !== undefined) {
            return await this.#installing;
        }
        const installing = this.#install(runtime).finally(() => {
            if (this.#installing === installing) {
                this.#installing = undefined;
            }
        });
        this.#installing = installing;
        return await installing;
    }

    async #install(runtime: AgentProviderRuntimePaths): Promise<PiProviderInstallation> {
        await rm(runtime.prefixDirectory, { force: true, recursive: true });
        await mkdir(runtime.prefixDirectory, { recursive: true });
        await writeFile(
            join(runtime.prefixDirectory, "package.json"),
            `${JSON.stringify({ name: "portable-devshell-agent-provider", private: true }, null, 2)}\n`,
            "utf8"
        );

        try {
            await this.#runner({
                args: [
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--package-lock=false",
                    "--save-exact",
                    `${this.#packageName}@${this.#version}`
                ],
                command: this.#npmCommand,
                cwd: runtime.prefixDirectory
            });
            const installed = await this.#readInstallation(runtime);
            if (installed === undefined) {
                throw new Error(`Pi provider installation did not produce ${this.#packageName}@${this.#version}.`);
            }
            return installed;
        } catch (error) {
            await rm(runtime.prefixDirectory, { force: true, recursive: true });
            throw error;
        }
    }

    async #readInstallation(runtime: AgentProviderRuntimePaths): Promise<PiProviderInstallation | undefined> {
        const packageRoot = join(
            runtime.prefixDirectory,
            "node_modules",
            ...this.#packageName.split("/")
        );
        try {
            const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
                version?: unknown;
            };
            if (manifest.version !== this.#version) {
                return undefined;
            }
            return {
                entrypoint: join(packageRoot, "dist", "index.js"),
                packageRoot,
                version: this.#version
            };
        } catch (error) {
            if (isMissingFile(error)) {
                return undefined;
            }
            throw error;
        }
    }
}

async function runInstallCommand(input: PiProviderInstallCommand): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(input.command, input.args, {
            cwd: input.cwd,
            env: {
                ...process.env,
                npm_config_update_notifier: "false"
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
                || Buffer.concat(stdout).toString("utf8").trim();
            reject(new Error(
                `Pi provider install failed (${signal ?? `exit ${code ?? "unknown"}`}): ${diagnostic || "npm failed without output"}`
            ));
        });
    });
}

function isMissingFile(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT";
}
