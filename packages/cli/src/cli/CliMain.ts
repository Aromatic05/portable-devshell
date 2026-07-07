#!/usr/bin/env node

import { CliParser, type CliParsedCommand } from "./CliParser.js";
import { CliControlClient, type CliControlClientLike } from "./control/CliControlClient.js";
import { CliCommandControlLogs } from "./command/control/CliCommandControlLogs.js";
import { CliCommandControlStart, type CliLifecycleManagerLike } from "./command/control/CliCommandControlStart.js";
import { CliCommandControlStatus } from "./command/control/CliCommandControlStatus.js";
import { CliCommandControlStop } from "./command/control/CliCommandControlStop.js";
import { CliCommandInstanceCall } from "./command/instance/CliCommandInstanceCall.js";
import { CliCommandInstanceList } from "./command/instance/CliCommandInstanceList.js";
import { CliCommandInstanceLogs } from "./command/instance/CliCommandInstanceLogs.js";
import { CliCommandInstanceStart } from "./command/instance/CliCommandInstanceStart.js";
import { CliCommandInstanceStatus } from "./command/instance/CliCommandInstanceStatus.js";
import { CliCommandInstanceStop } from "./command/instance/CliCommandInstanceStop.js";
import { CliCommandWatchLogs } from "./command/watch/CliCommandWatchLogs.js";
import { CliCommandWatchStatus } from "./command/watch/CliCommandWatchStatus.js";
import { cliExitCodes } from "./exit/CliExitCode.js";
import { CliExitMapper } from "./exit/CliExitMapper.js";
import { renderCliError } from "./render/CliRenderError.js";
import { renderControlLogs } from "./render/control/CliRenderControlLogs.js";
import { renderControlStatus } from "./render/control/CliRenderControlStatus.js";
import { renderInstanceList } from "./render/instance/CliRenderInstanceList.js";
import { renderInstanceLogs } from "./render/instance/CliRenderInstanceLogs.js";
import { renderInstanceSnapshot } from "./render/instance/CliRenderInstanceSnapshot.js";
import { renderToolCall } from "./render/tool/CliRenderToolCall.js";
import { renderToolResult } from "./render/tool/CliRenderToolResult.js";

export interface CliMainOptions {
    createClient?: () => CliControlClientLike;
    createLifecycleManager?: () => Promise<CliLifecycleManagerLike>;
    followEventLimit?: number;
    homeDirectory?: string;
    stderr?: { write(chunk: string): void };
    stdout?: { write(chunk: string): void };
    xdgRuntimeDir?: string;
}

export class CliMain {
    readonly #createClient: () => CliControlClientLike;
    readonly #createLifecycleManager?: () => Promise<CliLifecycleManagerLike>;
    readonly #exitMapper = new CliExitMapper();
    readonly #followEventLimit?: number;
    readonly #parser = new CliParser();
    readonly #stderr: { write(chunk: string): void };
    readonly #stdout: { write(chunk: string): void };
    readonly #homeDirectory?: string;
    readonly #xdgRuntimeDir?: string;

    constructor(options: CliMainOptions = {}) {
        this.#createClient = options.createClient ?? (() => new CliControlClient({ xdgRuntimeDir: this.#xdgRuntimeDir }));
        this.#createLifecycleManager = options.createLifecycleManager;
        this.#followEventLimit = options.followEventLimit;
        this.#stderr = options.stderr ?? process.stderr;
        this.#stdout = options.stdout ?? process.stdout;
        this.#homeDirectory = options.homeDirectory;
        this.#xdgRuntimeDir = options.xdgRuntimeDir;
    }

    async run(argv: readonly string[]): Promise<number> {
        try {
            await this.#execute(this.#parser.parse(argv));
            return cliExitCodes.success;
        } catch (error) {
            this.#stderr.write(renderCliError(error));
            return this.#exitMapper.map(error);
        }
    }

    async #execute(command: CliParsedCommand): Promise<void> {
        switch (command.kind) {
            case "control.start":
                this.#stdout.write(renderControlStatus(await new CliCommandControlStart().execute(await this.#lifecycle())));
                return;
            case "control.stop":
                this.#stdout.write(renderControlStatus(await new CliCommandControlStop().execute(await this.#lifecycle())));
                return;
            case "control.status":
                this.#stdout.write(renderControlStatus(await new CliCommandControlStatus().execute(await this.#lifecycle())));
                return;
            case "control.logs":
                this.#stdout.write(renderControlLogs(await new CliCommandControlLogs().execute(await this.#lifecycle())));
                return;
            case "instance.list":
                this.#stdout.write(renderInstanceList(await new CliCommandInstanceList().execute(this.#createClient())));
                return;
            case "instance.status":
                this.#stdout.write(
                    renderInstanceSnapshot((await new CliCommandInstanceStatus().execute(this.#createClient(), command.instance)).snapshot)
                );
                return;
            case "instance.start":
                this.#stdout.write(renderInstanceSnapshot(await new CliCommandInstanceStart().execute(this.#createClient(), command.instance)));
                return;
            case "instance.stop":
                this.#stdout.write(renderInstanceSnapshot(await new CliCommandInstanceStop().execute(this.#createClient(), command.instance)));
                return;
            case "instance.logs":
                if (command.follow) {
                    await new CliCommandWatchLogs().execute(
                        this.#createClient(),
                        command.instance,
                        async (entries) => {
                            this.#stdout.write(renderInstanceLogs(entries));
                        },
                        this.#followEventLimit
                    );
                    return;
                }

                this.#stdout.write(renderInstanceLogs(await new CliCommandInstanceLogs().execute(this.#createClient(), command.instance)));
                return;
            case "instance.call":
                this.#stdout.write(renderToolCall(command.instance, command.toolName));
                this.#stdout.write(
                    renderToolResult(
                        await new CliCommandInstanceCall().execute(this.#createClient(), command.instance, command.toolName, command.input)
                    )
                );
                return;
            case "watch.logs":
                await new CliCommandWatchLogs().execute(
                    this.#createClient(),
                    command.instance,
                    async (entries) => {
                        this.#stdout.write(renderInstanceLogs(entries));
                    },
                    this.#followEventLimit
                );
                return;
            case "watch.status":
                await new CliCommandWatchStatus().execute(
                    this.#createClient(),
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

        const moduleUrl = new URL("../../../control/dist/control/ControlLifecycleManager.js", import.meta.url);
        const imported = (await import(moduleUrl.href)) as {
            ControlLifecycleManager: new (options?: { homeDirectory?: string; xdgRuntimeDir?: string }) => CliLifecycleManagerLike;
        };

        return new imported.ControlLifecycleManager({
            homeDirectory: this.#homeDirectory,
            xdgRuntimeDir: this.#xdgRuntimeDir
        });
    }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
    const exitCode = await new CliMain().run(process.argv.slice(2));
    process.exit(exitCode);
}
