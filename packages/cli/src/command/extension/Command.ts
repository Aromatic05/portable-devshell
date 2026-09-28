import { spawnSync } from "node:child_process";
import {
    lstat,
    mkdtemp,
    readdir,
    rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CliRenderError } from "../../app/Failure.js";
import type { CliDispatchContext } from "../Dispatch.js";
import type { CliParsedCommand } from "../Parse.js";
import { renderExtensionList, renderExtensionUsage } from "./Render.js";

export function parseExtensionCommand(
    argv: readonly string[],
): CliParsedCommand {
    if (argv.length === 0) return { kind: "extension.help" };
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")
        return expectNoExtra(argv, { kind: "extension.help" });
    switch (argv[0]) {
        case "list":
            if (argv.length === 1)
                return { json: false, kind: "extension.list" };
            if (argv.length === 2 && argv[1] === "--json")
                return { json: true, kind: "extension.list" };
            throw CliRenderError.usage("extension list accepts only [--json]");
        case "install":
        case "update":
            if (argv.length !== 2)
                throw CliRenderError.usage(
                    `extension ${argv[0]} requires <bundle-or-directory|npm:package>`,
                );
            return {
                kind: "extension.install",
                source: required(
                    argv[1],
                    `extension ${argv[0]} source is required`,
                ),
            };
        case "remove": {
            if (argv.length < 2 || argv.length > 3)
                throw CliRenderError.usage(
                    "extension remove requires <extensionId> [--purge]",
                );
            const purge = argv[2] === "--purge";
            if (argv[2] !== undefined && !purge)
                throw CliRenderError.usage(
                    `Unknown extension remove option: ${argv[2]}`,
                );
            return {
                extensionId: extensionId(argv[1]),
                kind: "extension.remove",
                purge,
            };
        }
        case "inspect":
            if (argv.length !== 2)
                throw CliRenderError.usage(
                    "extension inspect requires <extensionId>",
                );
            return {
                extensionId: extensionId(argv[1]),
                kind: "extension.inspect",
            };
        case "enable":
        case "disable":
        case "reload":
            if (argv.length !== 2)
                throw CliRenderError.usage(
                    `extension ${argv[0]} requires <extensionId>`,
                );
            return {
                extensionId: extensionId(argv[1]),
                kind: `extension.${argv[0]}`,
            } as CliParsedCommand;
        default:
            throw CliRenderError.usage(
                `Unknown extension command: ${argv[0] ?? ""}`.trim(),
            );
    }
}

export function parseExtensionCliCommand(
    argv: readonly string[],
): CliParsedCommand {
    return {
        args: [...argv.slice(1)],
        commandId: cliCommandId(argv[0]),
        kind: "cli.command",
    };
}

export async function executeExtensionCommand(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "extension.help":
            context.stdout.write(`${renderExtensionUsage()}\n`);
            return true;
        case "extension.list": {
            const records = await context.clients.extension.list();
            if (command.json) context.writeJson(records);
            else context.writeRecords(records, renderExtensionList(records));
            return true;
        }
        case "extension.install": {
            const source = await materializeExtensionInstallSource(
                command.source,
            );
            try {
                context.writeJson(
                    await context.clients.extension.install(source.path),
                );
            } finally {
                await source.dispose();
            }
            return true;
        }
        case "extension.remove":
            context.writeJson(
                await context.clients.extension.remove(
                    command.extensionId,
                    command.purge,
                ),
            );
            return true;
        case "extension.inspect":
            context.writeJson(
                await context.clients.extension.get(command.extensionId),
            );
            return true;
        case "extension.enable":
            context.writeJson(
                await context.clients.extension.enable(command.extensionId),
            );
            return true;
        case "extension.disable":
            context.writeJson(
                await context.clients.extension.disable(command.extensionId),
            );
            return true;
        case "extension.reload":
            context.writeJson(
                await context.clients.extension.reload(command.extensionId),
            );
            return true;
        case "cli.command": {
            const result = await context.clients.cli.command(
                command.commandId,
                command.args,
                {
                    relay: {
                        input: context.stdin,
                        stderr: context.stderr,
                        stdout:
                            context.outputFormat === "text"
                                ? context.stdout
                                : context.stderr,
                    },
                    workingDirectory: process.cwd(),
                },
            );
            if (result.kind === "text") {
                const text = result.text ?? "";
                context.writeValue(
                    text,
                    text.endsWith("\n") ? text : `${text}\n`,
                );
            } else context.writeJson(result.value ?? null);
            return true;
        }
        default:
            return false;
    }
}

export interface MaterializedExtensionInstallSource {
    dispose(): Promise<void>;
    path: string;
}

export interface ExtensionInstallSourceOptions {
    installNpmPackage?: (spec: string, root: string) => Promise<void>;
}

export async function materializeExtensionInstallSource(
    source: string,
    options: ExtensionInstallSourceOptions = {},
): Promise<MaterializedExtensionInstallSource> {
    if (!source.startsWith("npm:")) {
        return {
            async dispose() {},
            path: resolve(source),
        };
    }
    const spec = source.slice("npm:".length).trim();
    if (spec.length === 0 || spec.startsWith("-")) {
        throw CliRenderError.usage(
            "extension npm source requires a package spec after npm:",
        );
    }

    const root = await mkdtemp(join(tmpdir(), "portable-devshell-extension-"));
    try {
        await (options.installNpmPackage ?? installNpmPackage)(spec, root);
        const candidates = await findInstalledExtensionPackages(
            join(root, "node_modules"),
        );
        if (candidates.length === 0) {
            throw new Error(
                `npm package ${spec} does not contain a root devshell-extension.json manifest.`,
            );
        }
        if (candidates.length !== 1) {
            throw new Error(
                `npm package ${spec} resolved to multiple Extension packages: ${candidates.join(", ")}.`,
            );
        }
        return {
            async dispose() {
                await rm(root, { force: true, recursive: true });
            },
            path: candidates[0]!,
        };
    } catch (error) {
        await rm(root, { force: true, recursive: true });
        throw error;
    }
}

function cliCommandId(value: string | undefined): string {
    const id = required(value, "CLI command id is required");
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return id;
    throw CliRenderError.usage("CLI command id must match [a-z][a-z0-9-]*");
}

function extensionId(value: string | undefined): string {
    const id = required(value, "extension id is required");
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return id;
    throw CliRenderError.usage("extension id must match [a-z][a-z0-9-]*");
}

function required(value: string | undefined, message: string): string {
    if (value) return value;
    throw CliRenderError.usage(message);
}

function expectNoExtra<T extends CliParsedCommand>(
    argv: readonly string[],
    value: T,
): T {
    if (argv.length !== 1)
        throw CliRenderError.usage(`Unexpected arguments for ${argv[0]}`);
    return value;
}

async function installNpmPackage(spec: string, root: string): Promise<void> {
    const result = spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        [
            "install",
            "--ignore-scripts",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--package-lock=false",
            "--prefix",
            root,
            "--",
            spec,
        ],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                NO_UPDATE_NOTIFIER: "1",
                npm_config_update_notifier: "false",
            },
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status === 0) return;
    const detail = [result.stderr, result.stdout]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .join("\n")
        .slice(-32 * 1024);
    throw new Error(
        `Failed to install Extension package ${spec} with npm (exit ${result.status ?? result.signal ?? "unknown"}).` +
            (detail.length === 0 ? "" : `\n${detail}`),
    );
}

async function findInstalledExtensionPackages(
    nodeModules: string,
): Promise<string[]> {
    const roots: string[] = [];
    const entries = await readdir(nodeModules, { withFileTypes: true }).catch(
        (error: unknown) => {
            if (isMissing(error)) return [];
            throw error;
        },
    );
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = join(nodeModules, entry.name);
        if (entry.name.startsWith("@")) {
            if (!entry.isDirectory()) continue;
            for (const scoped of await readdir(path, { withFileTypes: true })) {
                if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
                roots.push(join(path, scoped.name));
            }
            continue;
        }
        if (entry.isDirectory() || entry.isSymbolicLink()) roots.push(path);
    }
    const candidates: string[] = [];
    for (const root of roots) {
        const metadata = await lstat(
            join(root, "devshell-extension.json"),
        ).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (
            metadata !== undefined &&
            !metadata.isSymbolicLink() &&
            metadata.isFile()
        ) {
            candidates.push(root);
        }
    }
    return candidates.sort();
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
