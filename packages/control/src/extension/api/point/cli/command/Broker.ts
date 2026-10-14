import {
    createToolTransport,
    type Endpoint,
    type JsonValue,
} from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import type {
    CliCommandIo,
    CliModelCommandInvocationContext,
} from "@portable-devshell/extension/cli";

import type { ContextApi } from "../../../../../context/Api.js";
import { modelCommandAvailable } from "./Access.js";
import type { CliExtensionCommandService } from "./index.js";

/** Connect Worker-owned command sessions to authorized model CLI extensions. */
export class ModelCommandBroker {
    readonly #active = new Map<string, AbortController>();
    readonly #instances: { list(): readonly Instance[] };
    readonly #contexts: ContextApi;
    readonly #commands: CliExtensionCommandService;
    readonly #endpoint: Endpoint;
    readonly #listeners = new Map<Instance, () => void>();
    readonly #unsubscribe: () => void;

    constructor(options: {
        changes: { onChange(listener: () => void): () => void };
        commands: CliExtensionCommandService;
        contexts: ContextApi;
        endpoint: Endpoint;
        instances: { list(): readonly Instance[] };
    }) {
        this.#instances = options.instances;
        this.#contexts = options.contexts;
        this.#commands = options.commands;
        this.#endpoint = options.endpoint;
        this.#sync();
        this.#unsubscribe = options.changes.onChange(() => this.#sync());
    }

    close(): void {
        this.#unsubscribe();
        for (const release of this.#listeners.values()) release();
        this.#listeners.clear();
        for (const controller of this.#active.values()) controller.abort();
        this.#active.clear();
    }

    #sync(): void {
        const current = new Set(this.#instances.list());
        for (const [instance, release] of this.#listeners) {
            if (current.has(instance)) continue;
            release();
            this.#listeners.delete(instance);
        }
        for (const instance of current) {
            if (this.#listeners.has(instance)) continue;
            const sessions = instance.commandSessions;
            const offOpen = sessions.onOpen((request) => {
                const key = `${instance.config.name}\0${request.sessionId}`;
                if (this.#active.has(key)) return;
                const controller = new AbortController();
                this.#active.set(key, controller);
                void this.#handle(instance, request, controller.signal)
                    .catch(async (error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);
                        await sessions.output({
                            data: `${message}\n`, sessionId: request.sessionId, stream: "stderr",
                        }).catch(() => undefined);
                        await sessions.complete({
                            error: message, exitCode: 1, sessionId: request.sessionId,
                        }).catch(() => undefined);
                    })
                    .finally(() => {
                        if (this.#active.get(key) === controller) this.#active.delete(key);
                    });
            });
            const offClose = sessions.onClose(({ sessionId }) => {
                const key = `${instance.config.name}\0${sessionId}`;
                this.#active.get(key)?.abort();
                this.#active.delete(key);
            });
            this.#listeners.set(instance, () => {
                offOpen();
                offClose();
                const prefix = `${instance.config.name}\0`;
                for (const [key, controller] of this.#active) {
                    if (!key.startsWith(prefix)) continue;
                    controller.abort();
                    this.#active.delete(key);
                }
            });
        }
    }

    async #handle(
        instance: Instance,
        request: {
            argv: readonly string[];
            ctxId: string;
            parentCallId: string;
            sessionId: string;
            taskId?: string;
            workspace: string;
        },
        signal: AbortSignal,
    ): Promise<void> {
        const name = instance.config.name;
        const context = await this.#contexts.registry.validateForInstance(request.ctxId, name);
        if (!context.environments.some((environment) =>
            environment.instance === name && environment.workspace === request.workspace))
            throw new Error("Model command Workspace does not match the active Context.");
        const calls = await createToolTransport(this.#endpoint, name).listCalls({
            callIds: [request.parentCallId], includeOutput: true,
        });
        const parent = calls.find((call) => call.callId === request.parentCallId);
        if (parent?.source !== "mcp" || parent.ctxId !== request.ctxId ||
            parent.workspace !== request.workspace ||
            (request.taskId === undefined
                ? parent.toolName !== "bash_run" || parent.status !== "running"
                : parent.toolName !== "tmux_run" ||
                    (parent.status !== "running" &&
                        (parent.status !== "completed" || taskIdFromResult(parent.output) !== request.taskId))))
            throw new Error("Model command provenance does not match the owning ToolCall.");

        signal.throwIfAborted();
        const [commandId, ...argv] = request.argv;
        const allowed = this.#commands.list().filter((command) =>
            modelCommandAvailable(command, instance.config.modelExtensions));
        const sessions = instance.commandSessions;
        const output = async (stream: "stdout" | "stderr", data: string) => {
            for (const chunk of chunks(data)) {
                signal.throwIfAborted();
                await sessions.output({ data: chunk, sessionId: request.sessionId, stream });
            }
        };
        if (commandId === "--help" || commandId === "-h" || commandId === "help") {
            await output("stdout", `Model devshell commands:\n${allowed.map((command) =>
                `  ${command.id}${command.summary ? ` - ${command.summary}` : ""}`).join("\n")}\n`);
            await sessions.complete({ exitCode: 0, sessionId: request.sessionId });
            return;
        }
        if (!allowed.some((command) => command.id === commandId)) {
            await output("stderr", `CLI command ${commandId ?? ""} is unavailable.\n`);
            await sessions.complete({ exitCode: 127, sessionId: request.sessionId });
            return;
        }
        const io: CliCommandIo = {
            readInput: async () => undefined,
            requestInput: async () => {
                throw new Error("Model commands cannot request interactive input.");
            },
            writeStderr: async (text) => await output("stderr", text),
            writeStdout: async (text) => await output("stdout", text),
        };
        const invocation: CliModelCommandInvocationContext = {
            ctxId: request.ctxId,
            context: {
                instanceReference: (target) =>
                    this.#contexts.registry.referenceInstance(request.ctxId, target),
            },
            instance: name,
            io,
            requestId: request.sessionId,
            signal,
            workspace: request.workspace,
        };
        const result = await this.#commands.command(commandId!, argv, invocation, io);
        const rendered = result.kind === "text"
            ? result.text
            : result.text ?? JSON.stringify(result.value ?? null, null, 2);
        if (rendered) await output("stdout", rendered.endsWith("\n") ? rendered : `${rendered}\n`);
        await sessions.complete({ exitCode: 0, sessionId: request.sessionId });
    }
}

function taskIdFromResult(value: JsonValue | undefined): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const task = value.task;
    return task && typeof task === "object" && !Array.isArray(task) &&
        typeof task.id === "string" ? task.id : undefined;
}

function* chunks(value: string): Generator<string> {
    let current = "";
    let bytes = 0;
    for (const character of value) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > 128 * 1024 && current) {
            yield current;
            current = "";
            bytes = 0;
        }
        current += character;
        bytes += size;
    }
    if (current) yield current;
}
