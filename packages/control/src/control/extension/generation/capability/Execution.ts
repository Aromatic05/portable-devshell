import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionProcessStartInput,
    ExtensionWorkerCapability,
    ExtensionWorkerEnvironment,
    ExtensionWorkerOpenInput,
    ExtensionWorkerSession,
    ExtensionWorkerToolDefinition,
} from "@portable-devshell/extension";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@portable-devshell/shared";
import { InstanceConnectionService } from "../../../instance/registry/Connection.js";
import type { InstanceConnectionLease } from "../../../instance/registry/Connection.js";
import type { InstanceDescriptor } from "../../../instance/Descriptor.js";
import type { InstanceRegistry } from "../../../instance/registry/Registry.js";

const PROCESS_TERMINATE_GRACE_MS = 2_000;

export type ExtensionProcessSpawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
) => ChildProcess;

export interface ExtensionProcessCapabilityControlOptions {
    allowed: boolean;
    extensionId: string;
    generation: string;
    spawn?: ExtensionProcessSpawn;
}

/** Generation-owned process manager. Extensions never receive a native ChildProcess. */
export class ExtensionProcessCapabilityControl implements ExtensionProcessCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #generation: string;
    readonly #processes = new Set<ManagedExtensionProcess>();
    readonly #spawn: ExtensionProcessSpawn;
    #closed = false;

    constructor(options: ExtensionProcessCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#generation = options.generation;
        this.#spawn =
            options.spawn ??
            ((command, args, spawnOptions) =>
                nodeSpawn(command, [...args], spawnOptions));
    }

    async start(
        input: ExtensionProcessStartInput,
    ): Promise<ExtensionManagedProcess> {
        if (!this.#allowed) {
            throw new Error(
                `Extension ${this.#extensionId} did not declare the processes capability.`,
            );
        }
        if (this.#closed) {
            throw new Error(
                `Extension ${this.#extensionId} processes capability is closed.`,
            );
        }
        const normalized = normalizeStartInput(input);
        const child = this.#spawn(normalized.command, normalized.args, {
            cwd: normalized.cwd,
            env: {
                ...process.env,
                ...normalized.environment,
            },
            serialization: "json",
            stdio: normalized.messages
                ? ["ignore", "ignore", "pipe", "ipc"]
                : ["ignore", "ignore", "pipe"],
        });
        const managed = new ManagedExtensionProcess(child, normalized.messages);
        this.#processes.add(managed);
        void managed.closed.finally(() => this.#processes.delete(managed));
        if (this.#closed) {
            await managed.terminate();
            throw new Error(
                `Extension ${this.#extensionId} generation ${this.#generation} retired while starting a process.`,
            );
        }
        return managed;
    }

    async closeAll(): Promise<void> {
        if (this.#closed && this.#processes.size === 0) return;
        this.#closed = true;
        const processes = [...this.#processes];
        const settled = await Promise.allSettled(
            processes.map(async (process) => await process.terminate()),
        );
        const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `Extension ${this.#extensionId} generation ${this.#generation} processes failed to terminate.`,
            );
        }
    }
}

class ManagedExtensionProcess implements ExtensionManagedProcess {
    readonly #child: ChildProcess;
    readonly #messages: boolean;
    readonly #messageListeners = new Set<
        (message: ExtensionJsonValue) => void
    >();
    readonly #stderrListeners = new Set<(chunk: string) => void>();
    readonly closed: Promise<ExtensionProcessExit>;
    #closed = false;
    #resolveClosed!: (exit: ExtensionProcessExit) => void;
    #terminatePromise?: Promise<void>;

    constructor(child: ChildProcess, messages: boolean) {
        this.#child = child;
        this.#messages = messages;
        this.closed = new Promise<ExtensionProcessExit>((resolve) => {
            this.#resolveClosed = resolve;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            for (const listener of this.#stderrListeners) listener(chunk);
        });
        child.on("message", (value: unknown) => {
            const message = toJsonValue(value);
            if (message === undefined) return;
            for (const listener of this.#messageListeners) listener(message);
        });
        child.once("disconnect", () => {
            if (this.#messages && !this.#closed) {
                void this.terminate("SIGTERM").catch(() => undefined);
            }
        });
        child.once("error", () => this.#settle({}));
        child.once("exit", (code, signal) =>
            this.#settle({
                ...(code === null ? {} : { code }),
                ...(signal === null ? {} : { signal }),
            }),
        );
    }

    onMessage(listener: (message: ExtensionJsonValue) => void): () => void {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    onStderr(listener: (chunk: string) => void): () => void {
        this.#stderrListeners.add(listener);
        return () => this.#stderrListeners.delete(listener);
    }

    async send(message: ExtensionJsonValue): Promise<void> {
        if (!this.#messages)
            throw new Error(
                "Managed process was not started with a message channel.",
            );
        if (
            this.#closed ||
            !this.#child.connected ||
            this.#child.send === undefined
        ) {
            throw new Error("Managed process message channel is unavailable.");
        }
        const send = this.#child.send as (
            message: unknown,
            callback: (error: Error | null) => void,
        ) => boolean;
        await new Promise<void>((resolve, reject) => {
            send.call(this.#child, message, (error) =>
                error === null ? resolve() : reject(error),
            );
        });
    }

    async terminate(signal = "SIGTERM"): Promise<void> {
        this.#terminatePromise ??= this.#terminate(signal);
        await this.#terminatePromise;
    }

    async #terminate(signal: string): Promise<void> {
        if (this.#closed) return;
        this.#child.kill(signal as NodeJS.Signals);
        if (await settlesWithin(this.closed, PROCESS_TERMINATE_GRACE_MS))
            return;
        if (!this.#closed) this.#child.kill("SIGKILL");
        if (await settlesWithin(this.closed, PROCESS_TERMINATE_GRACE_MS))
            return;
        throw new Error("Managed process did not exit after SIGKILL.");
    }

    #settle(exit: ExtensionProcessExit): void {
        if (this.#closed) return;
        this.#closed = true;
        const settled = Object.freeze({ ...exit });
        this.#messageListeners.clear();
        this.#stderrListeners.clear();
        this.#resolveClosed(settled);
    }
}

interface NormalizedProcessStartInput {
    args: readonly string[];
    command: string;
    cwd?: string;
    environment: Readonly<Record<string, string>>;
    messages: boolean;
}

function normalizeStartInput(
    input: ExtensionProcessStartInput,
): NormalizedProcessStartInput {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new TypeError("Extension process start input must be an object.");
    }
    if (typeof input.command !== "string" || input.command.length === 0) {
        throw new TypeError(
            "Extension process command must be a non-empty string.",
        );
    }
    if (
        input.args !== undefined &&
        (!Array.isArray(input.args) ||
            input.args.some((argument) => typeof argument !== "string"))
    ) {
        throw new TypeError(
            "Extension process args must be an array of strings.",
        );
    }
    if (
        input.cwd !== undefined &&
        (typeof input.cwd !== "string" || input.cwd.length === 0)
    ) {
        throw new TypeError(
            "Extension process cwd must be a non-empty string when provided.",
        );
    }
    if (
        input.environment !== undefined &&
        (typeof input.environment !== "object" ||
            input.environment === null ||
            Array.isArray(input.environment) ||
            Object.values(input.environment).some(
                (value) => typeof value !== "string",
            ))
    ) {
        throw new TypeError(
            "Extension process environment must contain string values only.",
        );
    }
    if (input.messages !== undefined && typeof input.messages !== "boolean") {
        throw new TypeError(
            "Extension process messages must be boolean when provided.",
        );
    }
    return Object.freeze({
        args: Object.freeze([...(input.args ?? [])]),
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        environment: Object.freeze({ ...(input.environment ?? {}) }),
        messages: input.messages === true,
    });
}

function toJsonValue(value: unknown): ExtensionJsonValue | undefined {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) return undefined;
        return JSON.parse(encoded) as ExtensionJsonValue;
    } catch {
        return undefined;
    }
}

async function settlesWithin(
    promise: Promise<unknown>,
    timeoutMs: number,
): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

interface ExtensionWorkerConnectionPort {
    acquire(
        instance: string,
        reference: string,
    ): Promise<InstanceConnectionLease>;
    release(instance: string, reference: string): Promise<void>;
}

type ExtensionWorkerDescriptor = Pick<
    InstanceDescriptor,
    "enabled" | "name" | "provider"
>;

interface ManagedExtensionWorkerSession {
    instance: string;
    reference: string;
    sessionId: string;
    session: ExtensionWorkerSession;
}

export interface ExtensionWorkerCapabilityControlOptions {
    allowed: boolean;
    connections?: ExtensionWorkerConnectionPort;
    extensionId: string;
    generation: string;
    instances: InstanceRegistry;
    recording?: "caller" | "host";
}

export class ExtensionWorkerCapabilityControl implements ExtensionWorkerCapability {
    readonly #allowed: boolean;
    readonly #connections: ExtensionWorkerConnectionPort;
    readonly #extensionId: string;
    readonly #generation: string;
    readonly #instanceEpochs = new Map<string, number>();
    readonly #instances: InstanceRegistry;
    readonly #recording: "caller" | "host";
    readonly #retiringInstances = new Set<string>();
    readonly #sessions = new Map<string, ManagedExtensionWorkerSession>();
    #closed = false;

    constructor(options: ExtensionWorkerCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#connections =
            options.connections ??
            new InstanceConnectionService(options.instances);
        this.#extensionId = options.extensionId;
        this.#generation = options.generation;
        this.#instances = options.instances;
        this.#recording = options.recording ?? "host";
    }

    async openSession(
        input: ExtensionWorkerOpenInput,
    ): Promise<ExtensionWorkerSession> {
        if (!this.#allowed) {
            throw new Error(
                `Extension ${this.#extensionId} did not declare the workers capability.`,
            );
        }
        if (this.#closed)
            throw new Error(
                `Extension ${this.#extensionId} workers capability is closed.`,
            );
        if (input.workspace.length === 0)
            throw new TypeError(
                "Extension worker workspace must not be empty.",
            );

        const instance = resolveExtensionWorkerInstance(
            this.#instances.list(),
            input.instance,
        );
        if (this.#retiringInstances.has(instance)) {
            throw new Error(
                `Extension ${this.#extensionId} Worker instance ${instance} is retiring.`,
            );
        }
        const instanceEpoch = this.#instanceEpochs.get(instance) ?? 0;
        const sessionId = `ext-${randomUUID()}`;
        const reference = `extension-worker:${this.#extensionId}:${this.#generation}:${sessionId}`;
        const lease = await this.#connections.acquire(instance, reference);
        try {
            const environment = extensionWorkerEnvironment(
                lease.worker.handshake,
            );
            const prepared = await lease.worker.prepareWorkspace(
                input.workspace,
            );
            if (
                this.#closed ||
                this.#retiringInstances.has(instance) ||
                (this.#instanceEpochs.get(instance) ?? 0) !== instanceEpoch
            ) {
                throw new Error(
                    this.#closed
                        ? `Extension ${this.#extensionId} worker capability closed while opening a session.`
                        : `Extension ${this.#extensionId} Worker instance ${instance} retired while opening a session.`,
                );
            }
            let closePromise: Promise<void> | undefined;
            let toolSessionReleased = false;
            let connectionReleased = false;
            let closeCompleted = false;
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => {
                resolveClosed = resolve;
            });
            const close = async () => {
                if (closeCompleted) return;
                if (closePromise !== undefined) return await closePromise;
                const attempt = (async () => {
                    const failures: unknown[] = [];
                    if (!toolSessionReleased) {
                        try {
                            await lease.worker
                                .releaseToolSession(sessionId);
                            toolSessionReleased = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (!connectionReleased) {
                        try {
                            await this.#connections
                                .release(instance, reference);
                            connectionReleased = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            `Extension Worker session ${sessionId} failed to close cleanly.`,
                        );
                    }
                    closeCompleted = true;
                    this.#sessions.delete(sessionId);
                    resolveClosed();
                })();
                closePromise = attempt;
                try {
                    await attempt;
                } finally {
                    if (closePromise === attempt) closePromise = undefined;
                }
            };
            const session: ExtensionWorkerSession = {
                closed,
                environment,
                instance,
                workspace: prepared.workspace,
                callTool: async (toolName, toolInput, options = {}) =>
                    (await lease.worker.callTool(
                        toolName,
                        toolInput as JsonValue,
                        {
                            ctxId: sessionId,
                            extensionId: this.#extensionId,
                            ...(options.operationId === undefined
                                ? {}
                                : {
                                      operationId: options.operationId,
                                      requestId: options.operationId,
                                  }),
                            source: "extension",
                            workspace: prepared.workspace,
                        },
                        options.signal,
                        undefined,
                        undefined,
                        options.onProgress as
                            ((progress: JsonValue) => void) | undefined,
                        this.#recording,
                    )) as ExtensionJsonValue,
                close,
                listTools: () =>
                    lease.worker
                        .listTools()
                        .map(toExtensionWorkerToolDefinition),
            };
            this.#sessions.set(sessionId, {
                instance,
                reference,
                session,
                sessionId,
            });
            return session;
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await lease.worker
                .releaseToolSession(sessionId)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await this.#connections
                .release(instance, reference)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${this.#extensionId} worker session failed to open and cleanup was incomplete.`,
            );
        }
    }

    async retireInstance(instance: string): Promise<void> {
        this.#instanceEpochs.set(
            instance,
            (this.#instanceEpochs.get(instance) ?? 0) + 1,
        );
        this.#retiringInstances.add(instance);
        try {
            const sessions = [...this.#sessions.values()].filter(
                (candidate) => candidate.instance === instance,
            );
            const settled = await Promise.allSettled(
                sessions.map(
                    async (candidate) => await candidate.session.close(),
                ),
            );
            throwAggregateFailures(
                settled,
                `Extension ${this.#extensionId} worker sessions failed to retire instance ${instance}.`,
            );
        } finally {
            this.#retiringInstances.delete(instance);
        }
    }

    async closeAll(): Promise<void> {
        if (this.#closed && this.#sessions.size === 0) return;
        this.#closed = true;
        const settled = await Promise.allSettled(
            [...this.#sessions.values()].map(
                async (candidate) => await candidate.session.close(),
            ),
        );
        throwAggregateFailures(
            settled,
            `Extension ${this.#extensionId} worker sessions failed to close.`,
        );
    }
}

export function resolveExtensionWorkerInstance(
    descriptors: readonly ExtensionWorkerDescriptor[],
    instance?: string,
): string {
    if (instance !== undefined) return instance;
    const enabled = descriptors.filter((descriptor) => descriptor.enabled);
    const local = enabled.filter(
        (descriptor) => descriptor.provider === "local",
    );
    if (local.length === 1) return local[0]!.name;
    if (enabled.length === 1) return enabled[0]!.name;
    throw new Error(
        enabled.length === 0
            ? "No enabled devshell instance is available for this Extension."
            : "Multiple enabled devshell instances are available and no unique local instance can be selected.",
    );
}

function extensionWorkerEnvironment(
    handshake: InstanceDescriptor["worker"]["handshake"],
): ExtensionWorkerEnvironment {
    if (handshake === undefined) {
        throw new Error(
            "Extension worker session opened without a Worker handshake.",
        );
    }
    return Object.freeze({
        homeDirectory: handshake.homeDirectory,
        platform: Object.freeze({
            arch: handshake.platform.arch,
            ...(handshake.platform.distribution === undefined
                ? {}
                : {
                      distribution: Object.freeze({
                          ...handshake.platform.distribution,
                      }),
                  }),
            os: handshake.platform.os,
            ...(handshake.platform.packageManager === undefined
                ? {}
                : {
                      packageManager: handshake.platform.packageManager,
                  }),
            ...(handshake.platform.shell === undefined
                ? {}
                : {
                      shell: Object.freeze({ ...handshake.platform.shell }),
                  }),
        }),
    });
}

function toExtensionWorkerToolDefinition(tool: {
    description: string;
    inputSchema: JsonValue;
    name: string;
}): ExtensionWorkerToolDefinition {
    return {
        description: tool.description,
        inputSchema: tool.inputSchema as ExtensionJsonValue,
        name: tool.name,
    };
}

function throwAggregateFailures(
    settled: readonly PromiseSettledResult<void>[],
    message: string,
): void {
    const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
}
