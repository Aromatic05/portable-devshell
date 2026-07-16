#!/usr/bin/env node

import { isCliEntrypoint } from "./CliEntrypoint.js";
import { CliParser, type CliParsedCommand } from "./CliParser.js";
import { executeArtifactCommand } from "./command/artifact/CliCommandArtifact.js";
import { createCliClients as createControlClients, type CliClients } from "./client/CliClientComposition.js";
import { CliCommandInstanceCreate } from "./command/instance/CliCommandInstanceCreate.js";
import { CliCommandInstanceTodo } from "./command/instance/CliCommandInstanceTodo.js";
import { CliCommandWatchLogs } from "./command/watch/CliCommandWatchLogs.js";
import { CliCommandWatchStatus } from "./command/watch/CliCommandWatchStatus.js";
import { cliExitCodes } from "./exit/CliExitCode.js";
import { CliExitMapper } from "./exit/CliExitMapper.js";
import { renderCliError } from "./render/CliRenderError.js";
import { renderControlLogs } from "./render/control/CliRenderControlLogs.js";
import { renderControlStatus } from "./render/control/CliRenderControlStatus.js";
import { renderInstanceList } from "./render/instance/CliRenderInstanceList.js";
import { renderInstanceCreateResult } from "./render/instance/CliRenderInstanceCreate.js";
import { renderInstanceLogs } from "./render/instance/CliRenderInstanceLogs.js";
import { renderInstanceSnapshot } from "./render/instance/CliRenderInstanceSnapshot.js";
import {
    renderReverseDeviceCode,
    renderReverseTokenRevocation,
    renderReverseTokenRotation
} from "./render/instance/CliRenderInstanceReverse.js";
import { renderInstanceTodo } from "./render/instance/CliRenderInstanceTodo.js";
import { renderToolCall } from "./render/tool/CliRenderToolCall.js";
import { renderToolResult } from "./render/tool/CliRenderToolResult.js";
import { CliWizardInstanceCreate } from "./wizard/CliWizardInstanceCreate.js";

export interface CliMainOptions {
    createCliClients?: () => CliClients;
    createLifecycleManager?: () => Promise<CliLifecycleManagerLike>;
    followEventLimit?: number;
    homeDirectory?: string;
    runTui?: () => Promise<void>;
    stdin?: NodeJS.ReadableStream;
    stderr?: { write(chunk: string): void };
    stdout?: { write(chunk: string): void };
    xdgRuntimeDir?: string;
}

export interface CliLifecycleManagerLike {
    logs(): Promise<string>;
    start(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    status(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    stop(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
}

export class CliMain {
    readonly #clients: CliClients;
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
        this.#createLifecycleManager = options.createLifecycleManager;
        this.#followEventLimit = options.followEventLimit;
        this.#runTui = options.runTui;
        this.#stdin = options.stdin ?? process.stdin;
        this.#stderr = options.stderr ?? process.stderr;
        this.#stdout = options.stdout ?? process.stdout;
        this.#homeDirectory = options.homeDirectory;
        this.#xdgRuntimeDir = options.xdgRuntimeDir;
        this.#clients = options.createCliClients?.() ?? createControlClients({ xdgRuntimeDir: this.#xdgRuntimeDir });
    }

    async run(argv: readonly string[]): Promise<number> {
        const { commandArgs, debug, verbose } = splitGlobalFlags(argv);

        try {
            await this.#execute(this.#parser.parse(commandArgs));
            return cliExitCodes.success;
        } catch (error) {
            this.#stderr.write(renderCliError(error, { debug, verbose }));
            return this.#exitMapper.map(error);
        }
    }

    async #execute(command: CliParsedCommand): Promise<void> {
        switch (command.kind) {
            case "control.start":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).start()));
                return;
            case "control.stop":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).stop()));
                return;
            case "control.status":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).status()));
                return;
            case "control.logs":
                this.#stdout.write(renderControlLogs(await (await this.#lifecycle()).logs()));
                return;
            case "artifact":
                await executeArtifactCommand(command.args, this.#clients.artifact, this.#stdout);
                return;
            case "tui":
                await this.#startTui();
                return;
            case "instance.list":
                this.#stdout.write(renderInstanceList(await this.#clients.instance.list()));
                return;
            case "instance.create": {
                const result = await new CliCommandInstanceCreate().execute(
                    this.#clients.instance,
                    this.#clients.reverse,
                    new CliWizardInstanceCreate({
                        input: this.#stdin,
                        output: this.#stdout
                    })
                );

                if (result !== undefined) {
                    this.#stdout.write(renderInstanceCreateResult(result));
                }

                return;
            }
            case "instance.deviceCode":
                this.#stdout.write(
                    renderReverseDeviceCode(await this.#clients.reverse.createCode(command.instance))
                );
                return;
            case "instance.rotateToken":
                this.#stdout.write(
                    renderReverseTokenRotation(await this.#clients.reverse.rotateToken(command.instance))
                );
                return;
            case "instance.revokeToken":
                this.#stdout.write(
                    renderReverseTokenRevocation(await this.#clients.reverse.revokeToken(command.instance))
                );
                return;
            case "instance.status":
                this.#stdout.write(
                    renderInstanceSnapshot((await this.#clients.runtime.snapshot(command.instance)).snapshot)
                );
                return;
            case "instance.start":
                this.#stdout.write(
                    renderInstanceSnapshot(
                        await this.#clients.runtime.start(command.instance, {
                            input: this.#stdin,
                            output: this.#stderr
                        })
                    )
                );
                return;
            case "instance.stop":
                this.#stdout.write(renderInstanceSnapshot(await this.#clients.runtime.stop(command.instance)));
                return;
            case "instance.logs":
                if (command.follow) {
                    await new CliCommandWatchLogs().execute(
                        this.#clients.runtime,
                        command.instance,
                        async (entries) => {
                            this.#stdout.write(renderInstanceLogs(entries));
                        },
                        this.#followEventLimit
                    );
                    return;
                }

                this.#stdout.write(renderInstanceLogs(await this.#clients.runtime.readLogs(command.instance)));
                return;
            case "instance.todo":
                await new CliCommandInstanceTodo().execute(
                    this.#clients.todo,
                    command.instance,
                    command.follow,
                    async (todo) => {
                        this.#stdout.write(renderInstanceTodo(todo));
                    },
                    this.#followEventLimit
                );
                return;
            case "instance.call":
                this.#stdout.write(renderToolCall(command.instance, command.toolName));
                this.#stdout.write(
                    renderToolResult(await this.#clients.tool.call(command.instance, command.toolName, command.input))
                );
                return;
            case "watch.logs":
                await new CliCommandWatchLogs().execute(
                    this.#clients.runtime,
                    command.instance,
                    async (entries) => {
                        this.#stdout.write(renderInstanceLogs(entries));
                    },
                    this.#followEventLimit
                );
                return;
            case "watch.status":
                await new CliCommandWatchStatus().execute(
                    this.#clients.runtime,
                    command.instance,
                    async (snapshot) => {
                        this.#stdout.write(renderInstanceSnapshot(snapshot));
                    },
                    this.#followEventLimit
                );
                return;
        }
    }

    async #lifecycle(): Promise<CliLifecycleManagerLike> {
        if (this.#createLifecycleManager !== undefined) {
            return await this.#createLifecycleManager();
        }

        const [lifecycle, control] = await Promise.all([
            import("@portable-devshell/shared"),
            import("@portable-devshell/control")
        ]);
        return new lifecycle.ControlLifecycleManager({
            daemonModulePath: control.controlDaemonModulePath(),
            homeDirectory: this.#homeDirectory,
            xdgRuntimeDir: this.#xdgRuntimeDir
        });
    }

    async #startTui(): Promise<void> {
        if (this.#runTui !== undefined) {
            await this.#runTui();
            return;
        }

        const imported = (await import("@portable-devshell/tui")) as {
            runTui(options?: { xdgRuntimeDir?: string }): Promise<void>;
        };

        await imported.runTui({
            xdgRuntimeDir: this.#xdgRuntimeDir
        });
    }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
    const exitCode = await new CliMain().run(process.argv.slice(2));
    process.exit(exitCode);
}

function splitGlobalFlags(argv: readonly string[]): { commandArgs: string[]; debug: boolean; verbose: boolean } {
    const commandArgs = [...argv];
    let debug = false;
    let verbose = false;

    while (commandArgs[0] === "--verbose" || commandArgs[0] === "--debug") {
        if (commandArgs[0] === "--debug") {
            debug = true;
            verbose = true;
        } else {
            verbose = true;
        }
        commandArgs.shift();
    }

    return { commandArgs, debug, verbose };
}
