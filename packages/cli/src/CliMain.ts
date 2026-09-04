#!/usr/bin/env node

import type { ConfigBatchUpdateRequest, ConfigDraft } from "@portable-devshell/shared";

import { isCliEntrypoint } from "./CliEntrypoint.js";
import { CliParser, type CliParsedCommand } from "./CliParser.js";
import { executeArtifactCommand } from "./command/artifact/CliCommandArtifact.js";
import { executeSecretCommand } from "./command/secret/CliCommandSecretScan.js";
import { executeSkillCommand } from "./command/skill/CliCommandSkill.js";
import {
    createCliClients as createControlClients,
    negotiateCliControl,
    type CliClients,
} from "./client/CliClientComposition.js";
import { CliCommandInstanceCreate } from "./command/instance/CliCommandInstanceCreate.js";
import { CliCommandInstanceTodo } from "./command/instance/CliCommandInstanceTodo.js";
import { CliCommandWatchLogs } from "./command/watch/CliCommandWatchLogs.js";
import { CliCommandWatchStatus } from "./command/watch/CliCommandWatchStatus.js";
import { cliExitCodes } from "./exit/CliExitCode.js";
import { CliExitMapper } from "./exit/CliExitMapper.js";
import { renderCliError } from "./render/CliRenderError.js";
import { renderCliTopicUsage, renderCliUsage, renderInstanceUsage, renderWatchUsage } from "./render/CliRenderUsage.js";
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

export interface CliLifecycleManagerLike {
    logs(): Promise<string>;
    start(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    status(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    stop(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
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
        this.#clients = options.createCliClients?.() ?? createControlClients({
            ...(options.controlToken === undefined ? {} : { controlToken: options.controlToken }),
            ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }),
            xdgRuntimeDir: this.#xdgRuntimeDir
        });
    }

    async run(argv: readonly string[]): Promise<number> {
        const { commandArgs, debug, verbose } = splitGlobalFlags(argv);

        try {
            await this.#execute(this.#parser.parse(commandArgs));
            return cliExitCodes.success;
        } catch (error) {
            this.#stderr.write(renderCliError(error, { debug, verbose }));
            return this.#exitMapper.map(error);
        } finally {
            this.#clients.close?.();
        }
    }

    async #execute(command: CliParsedCommand): Promise<void> {
        if (commandUsesControlClient(command)) {
            await negotiateCliControl(this.#clients);
        }
        switch (command.kind) {
            case "help":
                this.#stdout.write(`${command.topic === undefined ? renderCliUsage() : renderCliTopicUsage(command.topic)}\n`);
                return;
            case "control.start":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).start()));
                return;
            case "control.restart": {
                const lifecycle = await this.#lifecycle();
                const current = await lifecycle.status();
                if (current.running) {
                    await negotiateCliControl(this.#clients);
                }
                const instancesToRestore = current.running
                    ? (await this.#clients.instance.list()).filter((entry) =>
                        entry.snapshot.reverse === undefined &&
                        (entry.snapshot.daemonState === "running" ||
                            entry.snapshot.daemonState === "starting" ||
                            entry.snapshot.daemonState === "stale")
                    )
                    : [];
                await lifecycle.stop();
                const status = await lifecycle.start();
                if (instancesToRestore.length > 0) {
                    await this.#clients.reconnect?.();
                    await negotiateCliControl(this.#clients);
                }
                for (const entry of instancesToRestore) {
                    await this.#clients.runtime.start(entry.name);
                }
                this.#stdout.write(renderControlStatus(status));
                return;
            }
            case "control.stop":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).stop()));
                return;
            case "control.status":
                this.#stdout.write(renderControlStatus(await (await this.#lifecycle()).status()));
                return;
            case "control.logs":
                this.#stdout.write(renderControlLogs(await (await this.#lifecycle()).logs()));
                return;
            case "overview":
                this.#writeJson(await this.#clients.overview.get());
                return;
            case "config.get":
                this.#writeJson(await this.#clients.config.get());
                return;
            case "config.validate":
                this.#writeJson(await this.#clients.config.validate(command.draft as ConfigDraft));
                return;
            case "config.update":
                this.#writeJson(await this.#clients.config.update(command.request as ConfigBatchUpdateRequest));
                return;
            case "approval.list":
                this.#writeJson(await this.#clients.tool.listApprovals(command.instance));
                return;
            case "approval.show":
                this.#writeJson(await this.#clients.tool.getApproval(command.instance, command.approvalId));
                return;
            case "approval.decide":
                this.#writeJson(
                    await this.#clients.tool.decideApproval(
                        command.instance,
                        command.approvalId,
                        command.decision,
                        {
                            ...(command.policyPatch === undefined ? {} : { policyPatch: command.policyPatch }),
                            ...(command.reason === undefined ? {} : { reason: command.reason }),
                            ...(command.remember === undefined ? {} : { remember: command.remember }),
                        },
                    ),
                );
                return;
            case "oauth.status":
                this.#writeJson(await this.#clients.mcp.status());
                return;
            case "oauth.list":
                this.#writeJson(await this.#clients.mcp.listApprovals());
                return;
            case "oauth.decide":
                this.#writeJson(
                    await this.#clients.mcp.decideApproval(command.approvalId, command.decision),
                );
                return;
            case "context.list":
                this.#writeJson(await this.#clients.context.list());
                return;
            case "context.messages":
                this.#writeJson(
                    await this.#clients.contextMessage.list(command.instance, command.ctxId),
                );
                return;
            case "context.send":
                this.#writeJson(
                    await this.#clients.contextMessage.queue(command.instance, {
                        ctxId: command.ctxId,
                        text: command.text,
                    }),
                );
                return;
            case "context.disable":
                this.#writeJson(await this.#clients.context.disable(command.ctxId));
                return;
            case "context.renew":
                this.#writeJson(await this.#clients.context.renew(command.ctxId));
                return;
            case "tool.calls":
                this.#writeJson(
                    await this.#clients.tool.listCalls(
                        command.instance,
                        command.callId === undefined
                            ? {
                                ...(command.after === undefined ? {} : { after: command.after }),
                                ...(command.before === undefined ? {} : { before: command.before }),
                                limit: command.limit ?? 200,
                            }
                            : { callIds: [command.callId], limit: 1 },
                    ),
                );
                return;
            case "todo.delete":
                this.#writeJson(await this.#clients.todo.delete(command.instance, command.taskId));
                return;
            case "artifact":
                await executeArtifactCommand(command.args, this.#clients.artifact, this.#stdout);
                return;
            case "secret":
                await executeSecretCommand(command.args, this.#stdout);
                return;
            case "skill":
                await executeSkillCommand(command.args, this.#stdout, { home: this.#homeDirectory });
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
            case "instance.delete":
                this.#writeJson(await this.#clients.instance.delete(command.instance));
                return;
            case "instance.enable":
                this.#writeJson(await this.#clients.instance.enable(command.instance));
                return;
            case "instance.disable":
                this.#writeJson(await this.#clients.instance.disable(command.instance));
                return;
            case "instance.help":
                this.#stdout.write(`${renderInstanceUsage()}\n`);
                return;
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
                    renderToolResult(await this.#clients.tool.call(command.instance, command.toolName, command.input, command.workspace))
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
            case "watch.help":
                this.#stdout.write(`${renderWatchUsage()}\n`);
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

    #writeJson(value: unknown): void {
        this.#stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
            ...(this.#controlToken === undefined ? {} : { controlToken: this.#controlToken }),
            ...(this.#controlUrl === undefined ? {} : { controlUrl: this.#controlUrl }),
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

function commandUsesControlClient(command: CliParsedCommand): boolean {
    if (command.kind === "artifact") {
        return ["share", "shares", "revoke", "transfer", "transfers"].includes(
            command.args[0] ?? "",
        );
    }
    if (
        command.kind === "overview" ||
        command.kind.startsWith("config.") ||
        command.kind.startsWith("approval.") ||
        command.kind.startsWith("oauth.") ||
        command.kind.startsWith("context.") ||
        command.kind.startsWith("tool.") ||
        command.kind.startsWith("todo.")
    ) {
        return true;
    }
    return (command.kind.startsWith("instance.") &&
            command.kind !== "instance.help") ||
        (command.kind.startsWith("watch.") && command.kind !== "watch.help");
}
