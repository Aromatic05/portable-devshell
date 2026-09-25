import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateControlState } from "@portable-devshell/control";
import type { JsonValue } from "@portable-devshell/shared";
import { CliParser, type CliParsedCommand } from "../command/Parse.js";
import {
    dispatchCliCommand,
    type CliOutputFormat,
} from "../command/Dispatch.js";
import { renderCliUsage } from "../command/Usage.js";
import type { CliLifecycleManagerLike } from "../command/control/service/Lifecycle.js";
import { cliBuiltinExtensionSources } from "../command/extension/Builtin.js";
import {
    createCliClients as createControlClients,
    negotiateCliControl,
    type CliClients,
} from "../transport/Client.js";
import {
    CliExitMapper,
    CliRenderError,
    cliExitCodes,
    renderCliError,
} from "./Failure.js";

export type { CliLifecycleManagerLike } from "../command/control/service/Lifecycle.js";

export interface CliMainOptions {
    createCliClients?: () => CliClients;
    controlToken?: string;
    controlUrl?: string;
    createLifecycleManager?: () => Promise<CliLifecycleManagerLike>;
    followEventLimit?: number;
    homeDirectory?: string;
    runTui?: () => Promise<void>;
    stdin?: NodeJS.ReadableStream;
    stderr?: { write(chunk: string): void };
    stdout?: { write(chunk: string): void };
    xdgRuntimeDir?: string;
}

export class CliMain {
    readonly #clients: CliClients;
    readonly #controlToken?: string;
    readonly #controlUrl?: string;
    readonly #createLifecycleManager?: () => Promise<CliLifecycleManagerLike>;
    readonly #exitMapper = new CliExitMapper();
    readonly #followEventLimit?: number;
    readonly #parser = new CliParser();
    readonly #runTui?: () => Promise<void>;
    readonly #stdin: NodeJS.ReadableStream;
    readonly #stderr: { write(chunk: string): void };
    readonly #stdout: { write(chunk: string): void };
    readonly #homeDirectory?: string;
    readonly #xdgRuntimeDir?: string;

    constructor(options: CliMainOptions = {}) {
        this.#controlToken = options.controlToken;
        this.#controlUrl = options.controlUrl;
        this.#createLifecycleManager = options.createLifecycleManager;
        this.#followEventLimit = options.followEventLimit;
        this.#runTui = options.runTui;
        this.#stdin = options.stdin ?? process.stdin;
        this.#stderr = options.stderr ?? process.stderr;
        this.#stdout = options.stdout ?? process.stdout;
        this.#homeDirectory = options.homeDirectory;
        this.#xdgRuntimeDir = options.xdgRuntimeDir;
        this.#clients =
            options.createCliClients?.() ??
            createControlClients({
                ...(options.controlToken === undefined
                    ? {}
                    : { controlToken: options.controlToken }),
                ...(options.controlUrl === undefined
                    ? {}
                    : { controlUrl: options.controlUrl }),
                xdgRuntimeDir: this.#xdgRuntimeDir,
            });
    }

    async run(argv: readonly string[]): Promise<number> {
        let debug = false;
        let verbose = false;
        try {
            const global = splitGlobalFlags(argv);
            debug = global.debug;
            verbose = global.verbose;
            const { commandArgs, outputFormat } = global;
            const resolved = await this.#resolve(commandArgs);
            await dispatchCliCommand(resolved.command, {
                clients: this.#clients,
                controlNegotiated: resolved.controlNegotiated,
                followEventLimit: this.#followEventLimit,
                outputFormat,
                stdin: this.#stdin,
                stderr: this.#stderr,
                stdout: this.#stdout,
                lifecycle: async () => await this.#lifecycle(),
                migrate: async () =>
                    await migrateControlState({
                        ...(this.#homeDirectory === undefined
                            ? {}
                            : { homeDirectory: this.#homeDirectory }),
                    }),
                negotiate: async () => await negotiateCliControl(this.#clients),
                readJson: async (source, label) =>
                    await readCliJsonSource(source, label, this.#stdin),
                requireStreamingOutput: (label) => {
                    if (outputFormat === "json")
                        throw CliRenderError.usage(
                            `${label} is streaming; use --output jsonl or text.`,
                        );
                },
                rootUsage: async () =>
                    await this.#rootUsage(resolved.controlNegotiated),
                startTui: async () => await this.#startTui(),
                version: () => resolvePortableDevshellApplicationVersion(),
                writeJson: (value) => {
                    if (outputFormat === "jsonl" && Array.isArray(value)) {
                        for (const record of value)
                            writeCliJson(this.#stdout, record, true);
                        return;
                    }
                    writeCliJson(this.#stdout, value, outputFormat === "jsonl");
                },
                writeRecords: (values, text) => {
                    if (outputFormat === "text") {
                        this.#stdout.write(text);
                        return;
                    }
                    if (outputFormat === "json") {
                        writeCliJson(this.#stdout, values, false);
                        return;
                    }
                    for (const value of values)
                        writeCliJson(this.#stdout, value, true);
                },
                writeValue: (value, text) => {
                    if (outputFormat === "text") this.#stdout.write(text);
                    else
                        writeCliJson(
                            this.#stdout,
                            value,
                            outputFormat === "jsonl",
                        );
                },
            });
            return cliExitCodes.success;
        } catch (error) {
            this.#stderr.write(renderCliError(error, { debug, verbose }));
            return this.#exitMapper.map(error);
        } finally {
            this.#clients.close?.();
        }
    }

    async #resolve(
        argv: readonly string[],
    ): Promise<{ command: CliParsedCommand; controlNegotiated: boolean }> {
        const commandId = argv[0];
        if (commandId === undefined || !/^[a-z][a-z0-9-]*$/u.test(commandId)) {
            return {
                command: this.#parser.parse(argv),
                controlNegotiated: false,
            };
        }
        if ((localCliCommands as readonly string[]).includes(commandId)) {
            return {
                command: this.#parser.parse(argv),
                controlNegotiated: false,
            };
        }
        try {
            await negotiateCliControl(this.#clients);
            const commands = await this.#clients.cli.commands();
            const overlay = commands.find(
                (candidate) => candidate.id === commandId,
            );
            if (overlay !== undefined) {
                return {
                    command: {
                        args: normalizeExtensionCommandArgs(argv.slice(1)),
                        commandId,
                        kind: "cli.command",
                    },
                    controlNegotiated: true,
                };
            }
            const suggestion = suggestCliCommand(
                commandId,
                commands.map((candidate) => candidate.id),
            );
            if (suggestion !== undefined) {
                throw CliRenderError.usage(
                    `Unknown command "${commandId}". Did you mean "${suggestion}"?`,
                );
            }
            return {
                command: this.#parser.parse(argv),
                controlNegotiated: true,
            };
        } catch (error) {
            if (
                error instanceof CliRenderError &&
                error.code === "control.notRunning"
            ) {
                return {
                    command: this.#parser.parse(argv),
                    controlNegotiated: false,
                };
            }
            throw error;
        }
    }

    async #lifecycle(): Promise<CliLifecycleManagerLike> {
        if (this.#createLifecycleManager !== undefined)
            return await this.#createLifecycleManager();
        const [lifecycle, control] = await Promise.all([
            import("@portable-devshell/shared"),
            import("@portable-devshell/control"),
        ]);
        return new lifecycle.ControlLifecycleManager({
            daemonModulePath: control.controlDaemonModulePath(),
            env: {
                [control.CONTROL_BUILTIN_EXTENSION_SOURCES_ENV]: JSON.stringify(
                    cliBuiltinExtensionSources(),
                ),
            },
            homeDirectory: this.#homeDirectory,
            xdgRuntimeDir: this.#xdgRuntimeDir,
        });
    }

    async #rootUsage(controlNegotiated: boolean): Promise<string> {
        try {
            if (!controlNegotiated) await negotiateCliControl(this.#clients);
            return renderCliUsage(await this.#clients.cli.commands());
        } catch {
            return renderCliUsage();
        }
    }

    async #startTui(): Promise<void> {
        if (this.#runTui !== undefined) {
            await this.#runTui();
            return;
        }
        const imported = (await import("@portable-devshell/tui")) as {
            runTui(options?: {
                controlToken?: string;
                controlUrl?: string;
                xdgRuntimeDir?: string;
            }): Promise<void>;
        };
        await imported.runTui({
            ...(this.#controlToken === undefined
                ? {}
                : { controlToken: this.#controlToken }),
            ...(this.#controlUrl === undefined
                ? {}
                : { controlUrl: this.#controlUrl }),
            xdgRuntimeDir: this.#xdgRuntimeDir,
        });
    }
}

async function readCliJsonSource(
    source: string,
    label: string,
    stdin: NodeJS.ReadableStream,
): Promise<JsonValue> {
    let text = source;
    if (source === "-") {
        text = await readCliStdin(stdin);
    } else if (source.startsWith("@")) {
        const path = source.slice(1);
        if (path.length === 0)
            throw CliRenderError.usage(
                `${label} file path is required after @`,
            );
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            throw CliRenderError.usage(
                `Could not read ${label} from ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    try {
        return JSON.parse(text) as JsonValue;
    } catch {
        throw CliRenderError.usage(`${label} must be valid JSON`);
    }
}

async function readCliStdin(stdin: NodeJS.ReadableStream): Promise<string> {
    let text = "";
    for await (const chunk of stdin as AsyncIterable<string | Buffer>)
        text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return text;
}

const builtinCliCommands = [
    "approval",
    "config",
    "context",
    "debug",
    "extension",
    "help",
    "init",
    "instance",
    "logs",
    "migrate",
    "oauth",
    "overview",
    "restart",
    "start",
    "status",
    "stop",
    "todo",
    "tool",
    "tui",
    "watch",
] as const;

const localCliCommands = ["migrate"] as const;

function suggestCliCommand(
    command: string,
    extensionCommands: readonly string[],
): string | undefined {
    if ((builtinCliCommands as readonly string[]).includes(command))
        return undefined;
    const candidates = [...builtinCliCommands, ...extensionCommands].filter(
        (candidate, index, values) => values.indexOf(candidate) === index,
    );
    let best: { command: string; distance: number } | undefined;
    for (const candidate of candidates) {
        const distance = editDistance(command, candidate);
        if (best === undefined || distance < best.distance)
            best = { command: candidate, distance };
    }
    const threshold = command.length <= 4 ? 1 : command.length <= 8 ? 2 : 3;
    return best !== undefined && best.distance <= threshold
        ? best.command
        : undefined;
}

function editDistance(left: string, right: string): number {
    let previous = Array.from(
        { length: right.length + 1 },
        (_, index) => index,
    );
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
        const current = [leftIndex + 1];
        for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
            current.push(
                Math.min(
                    current[rightIndex]! + 1,
                    previous[rightIndex + 1]! + 1,
                    previous[rightIndex]! +
                        (left[leftIndex] === right[rightIndex] ? 0 : 1),
                ),
            );
        }
        previous = current;
    }
    return previous[right.length] ?? left.length;
}

function normalizeExtensionCommandArgs(args: readonly string[]): string[] {
    const trailing = args.at(-1);
    if (trailing === "--help" || trailing === "-h") return ["help"];
    return [...args];
}

function splitGlobalFlags(argv: readonly string[]): {
    commandArgs: string[];
    debug: boolean;
    outputFormat: CliOutputFormat;
    verbose: boolean;
} {
    const commandArgs = [...argv];
    let debug = false;
    let outputFormat: CliOutputFormat = "text";
    let verbose = false;
    while (true) {
        const option = commandArgs[0];
        if (option === "--debug") {
            debug = true;
            verbose = true;
            commandArgs.shift();
            continue;
        }
        if (option === "--verbose") {
            verbose = true;
            commandArgs.shift();
            continue;
        }
        if (option === "--output") {
            commandArgs.shift();
            outputFormat = parseCliOutputFormat(commandArgs.shift());
            continue;
        }
        if (option?.startsWith("--output=") === true) {
            commandArgs.shift();
            outputFormat = parseCliOutputFormat(
                option.slice("--output=".length),
            );
            continue;
        }
        break;
    }
    return { commandArgs, debug, outputFormat, verbose };
}

function parseCliOutputFormat(value: string | undefined): CliOutputFormat {
    if (value === "text" || value === "json" || value === "jsonl") return value;
    throw CliRenderError.usage("--output requires one of: text, json, jsonl");
}

function writeCliJson(
    output: { write(chunk: string): void },
    value: unknown,
    compact: boolean,
): void {
    output.write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

function resolvePortableDevshellApplicationVersion(
    startUrl = import.meta.url,
): string {
    let directory = dirname(fileURLToPath(startUrl));
    while (true) {
        const manifestPath = join(directory, "package.json");
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (manifest.name === "portable-devshell") {
                if (
                    typeof manifest.version !== "string" ||
                    manifest.version.length === 0
                )
                    throw new Error(
                        `Application package version is invalid: ${manifestPath}`,
                    );
                return manifest.version;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error(
        "Cannot locate portable-devshell application package manifest.",
    );
}
