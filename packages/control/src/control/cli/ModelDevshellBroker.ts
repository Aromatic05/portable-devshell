import type {
    WorkerDevshellCommandClose,
    WorkerDevshellCommandOpen
} from "@portable-devshell/core";
import {
    errorCodes,
    toControlErrorBody,
    type CliCommandDescriptor,
    type JsonValue,
    type McpContextRecord,
    type ToolCallRecord
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import type { ContextAdminPort } from "../mcp/ContextRouteModule.js";
import type { CliExtensionCommandService } from "./CliExtensionCommandService.js";
import type { CliCommandIo, CliModelCommandContext } from "@portable-devshell/extension/cli";

export interface ModelDevshellAccessInput {
    commandId: string;
    ctxId: string;
    extensionId: string;
    instance: string;
}

export interface ModelDevshellAccessPort {
    allows(input: ModelDevshellAccessInput): boolean | Promise<boolean>;
}

export interface ModelDevshellBrokerOptions {
    access: ModelDevshellAccessPort;
    commands: CliExtensionCommandService;
    contextAdmin: () => ContextAdminPort | undefined;
    instances: InstanceRegistry;
}

export class ModelDevshellBroker {
    readonly #access: ModelDevshellAccessPort;
    readonly #active = new Map<string, AbortController>();
    readonly #commands: CliExtensionCommandService;
    readonly #contextAdmin: () => ContextAdminPort | undefined;
    readonly #instances: InstanceRegistry;
    readonly #subscriptions = new Map<object, () => void>();
    readonly #unsubscribeRegistry: () => void;
    #disposed = false;

    constructor(options: ModelDevshellBrokerOptions) {
        this.#access = options.access;
        this.#commands = options.commands;
        this.#contextAdmin = options.contextAdmin;
        this.#instances = options.instances;
        this.#syncWorkers();
        this.#unsubscribeRegistry = this.#instances.onChange(() => this.#syncWorkers());
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#unsubscribeRegistry();
        for (const controller of this.#active.values()) {
            controller.abort(new Error("Model devshell broker is stopping."));
        }
        this.#active.clear();
        for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
        this.#subscriptions.clear();
    }

    #syncWorkers(): void {
        if (this.#disposed) return;
        const workers = new Set(this.#instances.list().map((descriptor) => descriptor.worker));
        for (const [worker, unsubscribe] of this.#subscriptions) {
            if (workers.has(worker as never)) continue;
            unsubscribe();
            this.#subscriptions.delete(worker);
        }
        for (const descriptor of this.#instances.list()) {
            if (this.#subscriptions.has(descriptor.worker)) continue;
            const unsubscribeOpen = descriptor.worker.onDevshellCommandOpen((request) => {
                this.#acceptOpen(descriptor, request);
            });
            const unsubscribeClose = descriptor.worker.onDevshellCommandClose((request) => {
                this.#acceptClose(descriptor, request);
            });
            this.#subscriptions.set(descriptor.worker, () => {
                unsubscribeOpen();
                unsubscribeClose();
                this.#abortInstanceSessions(descriptor.name);
            });
        }
    }

    #acceptOpen(descriptor: InstanceDescriptor, request: WorkerDevshellCommandOpen): void {
        const key = sessionKey(descriptor.name, request.sessionId);
        if (this.#active.has(key)) {
            const error = integrityError("Worker reused an active model devshell session id.");
            void this.#recordIntegrityFault(descriptor, request, error)
                .then(async () => await this.#completeFailure(descriptor, request.sessionId, error))
                .catch(() => undefined);
            return;
        }
        const controller = new AbortController();
        this.#active.set(key, controller);
        void this.#handle(descriptor, request, controller.signal)
            .catch(async (error: unknown) => {
                await this.#completeFailure(descriptor, request.sessionId, error).catch(() => undefined);
            })
            .finally(() => {
                if (this.#active.get(key) === controller) this.#active.delete(key);
            });
    }

    #acceptClose(descriptor: InstanceDescriptor, request: WorkerDevshellCommandClose): void {
        const key = sessionKey(descriptor.name, request.sessionId);
        const controller = this.#active.get(key);
        if (controller === undefined) return;
        this.#active.delete(key);
        controller.abort(new Error("Model devshell client closed the broker session."));
    }

    #abortInstanceSessions(instance: string): void {
        const prefix = `${instance}\u0000`;
        for (const [key, controller] of this.#active) {
            if (!key.startsWith(prefix)) continue;
            this.#active.delete(key);
            controller.abort(new Error(`Instance ${instance} retired its model devshell sessions.`));
        }
    }

    async #handle(
        descriptor: InstanceDescriptor,
        request: WorkerDevshellCommandOpen,
        signal: AbortSignal
    ): Promise<void> {
        try {
            await this.#validateProvenance(descriptor, request);
        } catch (error) {
            await this.#recordIntegrityFault(descriptor, request, error);
            throw error;
        }

        const [commandId, ...argv] = request.argv;
        if (commandId === "--help" || commandId === "-h" || commandId === "help") {
            await this.#write(descriptor, request.sessionId, "stdout", await this.#renderHelp(descriptor, request.ctxId));
            await descriptor.worker.completeDevshellCommand({ exitCode: 0, sessionId: request.sessionId });
            return;
        }

        const command = this.#commands.list().find((candidate) => candidate.id === commandId);
        if (
            command === undefined ||
            !await this.#access.allows({
                commandId,
                ctxId: request.ctxId,
                extensionId: command.extensionId,
                instance: descriptor.name
            })
        ) {
            await this.#write(
                descriptor,
                request.sessionId,
                "stderr",
                `CLI command ${commandId} is unavailable.\n`
            );
            await descriptor.worker.completeDevshellCommand({ exitCode: 127, sessionId: request.sessionId });
            return;
        }

        const io: CliCommandIo = {
            async readInput() {
                return undefined;
            },
            async requestInput() {
                throw new Error("Model devshell commands do not support interactive input yet.");
            },
            writeStderr: async (chunk) => await this.#write(descriptor, request.sessionId, "stderr", chunk),
            writeStdout: async (chunk) => await this.#write(descriptor, request.sessionId, "stdout", chunk)
        };
        const modelContext: CliModelCommandContext = Object.freeze({
            connectInstance: async (instance: string, workspace?: string) => {
                const admin = this.#contextAdmin();
                if (admin === undefined) throw integrityError("MCP Context authority is unavailable.");
                return await admin.connectInstance(request.ctxId, instance, workspace, signal);
            }
        });
        try {
            const result = await this.#commands.command(
                commandId,
                argv,
                {
                    context: modelContext,
                    instance: descriptor.name,
                    requestId: request.sessionId,
                    signal,
                    workspace: request.workspace
                },
                io
            );
            if (result.kind === "text") {
                if (result.text.length > 0) {
                    await this.#write(
                        descriptor,
                        request.sessionId,
                        "stdout",
                        result.text.endsWith("\n") ? result.text : `${result.text}\n`
                    );
                }
            } else {
                await this.#write(
                    descriptor,
                    request.sessionId,
                    "stdout",
                    `${JSON.stringify(result.value ?? null, null, 2)}\n`
                );
            }
            await descriptor.worker.completeDevshellCommand({ exitCode: 0, sessionId: request.sessionId });
        } catch (error) {
            await this.#completeFailure(descriptor, request.sessionId, error);
        }
    }

    async #validateProvenance(
        descriptor: InstanceDescriptor,
        request: WorkerDevshellCommandOpen
    ): Promise<void> {
        const [record] = await descriptor.worker.readToolCalls({
            callIds: [request.parentCallId],
            includeInput: true,
            includeOutput: true
        });
        if (
            record === undefined ||
            record.callId !== request.parentCallId ||
            record.source !== "mcp" ||
            record.ctxId !== request.ctxId ||
            record.workspace !== request.workspace
        ) {
            throw integrityError("Worker model devshell provenance does not match the authoritative tool call.");
        }

        const context = await this.#requireContext(request.ctxId, descriptor.name);
        if (context.workspace !== request.workspace || context.instance !== descriptor.name) {
            throw integrityError("Worker model devshell context binding does not match the authoritative MCP Context.");
        }

        if (request.taskId === undefined) {
            if (record.toolName !== "bash_run" || record.status !== "running") {
                throw integrityError("Worker model devshell request is not owned by an active bash_run call.");
            }
            return;
        }

        if (record.toolName !== "tmux_run") {
            throw integrityError("Worker model devshell task binding does not originate from tmux_run.");
        }
        if (record.status === "running") return;
        if (record.status !== "completed" || readTmuxTaskId(record) !== request.taskId) {
            throw integrityError("Worker model devshell task id does not match the completed tmux_run result.");
        }
    }

    async #requireContext(ctxId: string, instance: string): Promise<McpContextRecord> {
        const admin = this.#contextAdmin();
        if (admin === undefined) {
            throw integrityError("MCP Context authority is unavailable.");
        }
        try {
            return await admin.validateForInstance(ctxId, instance);
        } catch {
            throw integrityError("Worker model devshell Context is unavailable, expired, disabled, or bound elsewhere.");
        }
    }

    async #renderHelp(descriptor: InstanceDescriptor, ctxId: string): Promise<string> {
        const allowed: CliCommandDescriptor[] = [];
        for (const command of this.#commands.list()) {
            if (await this.#access.allows({
                commandId: command.id,
                ctxId,
                extensionId: command.extensionId,
                instance: descriptor.name
            })) {
                allowed.push(command);
            }
        }
        const lines = ["Model devshell commands:"];
        if (allowed.length === 0) lines.push("  none");
        else {
            for (const command of allowed) {
                lines.push(`  ${command.id}${command.summary === undefined ? "" : ` - ${command.summary}`}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }

    async #write(
        descriptor: InstanceDescriptor,
        sessionId: string,
        stream: "stderr" | "stdout",
        text: string
    ): Promise<void> {
        for (const data of chunks(text)) {
            await descriptor.worker.writeDevshellCommandOutput({ data, sessionId, stream });
        }
    }

    async #completeFailure(
        descriptor: InstanceDescriptor,
        sessionId: string,
        error: unknown
    ): Promise<void> {
        const body = toControlErrorBody(error);
        const message = body?.message ?? (error instanceof Error ? error.message : String(error));
        const exitCode = body?.code === "cli.usage"
            ? 2
            : body?.code === errorCodes.controlCliCommandFailed
                ? 127
                : 1;
        await this.#write(descriptor, sessionId, "stderr", `${message}\n`).catch(() => undefined);
        await descriptor.worker.completeDevshellCommand({ exitCode, sessionId }).catch(() => undefined);
    }

    async #recordIntegrityFault(
        descriptor: InstanceDescriptor,
        request: WorkerDevshellCommandOpen,
        error: unknown
    ): Promise<void> {
        await descriptor.worker.appendControlEvent("worker.protocolIntegrityFault", {
            ctxId: request.ctxId,
            parentCallId: request.parentCallId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            workspace: request.workspace,
            message: error instanceof Error ? error.message : String(error)
        } as JsonValue).catch(() => undefined);
    }
}

function readTmuxTaskId(record: ToolCallRecord): string | undefined {
    const output = record.output;
    if (!isRecord(output) || !isRecord(output.task)) return undefined;
    return typeof output.task.id === "string" ? output.task.id : undefined;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integrityError(message: string): Error {
    const error = new Error(message);
    error.name = "WorkerProtocolIntegrityError";
    return error;
}

function sessionKey(instance: string, sessionId: string): string {
    return `${instance}\u0000${sessionId}`;
}

function chunks(text: string): string[] {
    const result: string[] = [];
    let current = "";
    let bytes = 0;
    for (const character of text) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > 128 * 1024 && current.length > 0) {
            result.push(current);
            current = "";
            bytes = 0;
        }
        current += character;
        bytes += size;
    }
    if (current.length > 0) result.push(current);
    return result;
}
