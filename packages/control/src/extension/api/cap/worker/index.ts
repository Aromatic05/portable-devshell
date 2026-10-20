import { randomUUID } from "node:crypto";

import type { Instance } from "@portable-devshell/core";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionWorkerCallOptions,
    ExtensionWorkerEnvironment,
    ExtensionWorkerOpenInput,
    ExtensionWorkerSession,
    ExtensionWorkerToolDefinition,
} from "@portable-devshell/extension/worker";
import type { JsonValue } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../../../instance/Api.js";
import type { ExtensionWorkerRuntime } from "../index.js";

/** Extension generation-owned sessions; execution and Audit remain Instance-owned. */
export class ExtensionWorkerCapabilityControl implements ExtensionWorkerRuntime {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #instances: InstanceRegistry;
    readonly #recording: "host" | "caller";
    readonly #validateContext?: (ctxId: string, instance: string, workspace: string) => Promise<void>;
    readonly #sessions = new Set<ExtensionWorkerSessionControl>();
    readonly #opening = new Set<{ instance: string; promise: Promise<ExtensionWorkerSession> }>();
    readonly #retiring = new Map<string, Promise<void>>();
    #closed = false;
    #closePromise?: Promise<void>;

    constructor(options: {
        allowed: boolean;
        extensionId: string;
        instances: InstanceRegistry;
        recording: "host" | "caller";
        validateContext?: (ctxId: string, instance: string, workspace: string) => Promise<void>;
    }) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
        this.#recording = options.recording;
        this.#validateContext = options.validateContext;
    }

    async openSession(input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession> {
        if (!this.#allowed)
            throw new Error(`Extension ${this.#extensionId} did not declare this Worker capability.`);
        if (this.#closed)
            throw new Error(`Extension ${this.#extensionId} Worker capability is closed.`);
        const instance = this.#resolve(input.instance);
        const promise = this.#open(instance, input);
        const pending = { instance: instance.config.name, promise };
        this.#opening.add(pending);
        try {
            return await promise;
        } finally {
            this.#opening.delete(pending);
        }
    }

    retireInstance(instance: string): Promise<void> {
        const retiring = this.#retiring.get(instance);
        if (retiring !== undefined) return retiring;
        const promise = Promise.resolve().then(() => this.#drain(instance)).finally(() => {
            this.#retiring.delete(instance);
        });
        this.#retiring.set(instance, promise);
        for (const session of this.#sessions) {
            if (session.instance === instance) session.abort();
        }
        return promise;
    }

    closeAll(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#closed = true;
        this.#closePromise = Promise.resolve().then(() => this.#drain()).catch((error: unknown) => {
            this.#closePromise = undefined;
            throw error;
        });
        for (const session of this.#sessions) session.abort();
        return this.#closePromise;
    }

    async #drain(instance?: string): Promise<void> {
        const sessions = new Set([...this.#sessions].filter(
            (session) => instance === undefined || session.instance === instance,
        ));
        // Abort existing calls before waiting for opens; keep every failed release owned.
        const closing = Promise.allSettled([...sessions].map((session) => session.close()));
        await Promise.allSettled([...this.#opening].filter(
            (entry) => instance === undefined || entry.instance === instance,
        ).map((entry) => entry.promise));
        const late = await Promise.allSettled([...this.#sessions].filter(
            (session) => !sessions.has(session) && (instance === undefined || session.instance === instance),
        ).map((session) => session.close()));
        const results = [...await closing, ...late];
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(failures, "Extension Worker sessions failed to close.");
    }

    #resolve(name: string | undefined): Instance {
        if (name !== undefined) {
            const instance = this.#instances.get(name);
            if (instance === undefined || !instance.lifecycle.active || this.#retiring.has(name))
                throw new Error(`Worker Instance ${name} is unavailable.`);
            return instance;
        }
        const available = this.#instances.list().filter(
            (instance) => instance.lifecycle.active && !this.#retiring.has(instance.config.name),
        );
        if (available.length !== 1)
            throw new Error("Worker session requires an explicit Instance unless exactly one is active.");
        return available[0]!;
    }

    async #open(instance: Instance, input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession> {
        const sessionId = randomUUID();
        const opened = await instance.openToolSession(input.workspace, sessionId);
        const session = new ExtensionWorkerSessionControl({
            ctxId: input.ctxId,
            extensionId: this.#extensionId,
            instance,
            opened,
            onClosed: (closed) => this.#sessions.delete(closed),
            recording: this.#recording,
            sessionId,
        });
        this.#sessions.add(session);
        try {
            if (input.ctxId !== undefined) {
                if (this.#validateContext === undefined)
                    throw new Error("Worker Context binding cannot be validated.");
                await this.#validateContext(input.ctxId, instance.config.name, opened.workspace);
            }
            if (this.#closed || this.#retiring.has(instance.config.name) || !instance.lifecycle.active)
                throw new Error(`Worker Instance ${instance.config.name} retired while opening a session.`);
        } catch (error) {
            await session.close();
            throw error;
        }
        session.watchRetirement();
        return session;
    }
}

class ExtensionWorkerSessionControl implements ExtensionWorkerSession {
    readonly environment: ExtensionWorkerEnvironment;
    readonly instance: string;
    readonly workspace: string;
    readonly #instance: Instance;
    readonly #onClosed: (session: ExtensionWorkerSessionControl) => void;
    readonly #ctxId?: string;
    readonly #extensionId: string;
    readonly #recording: "host" | "caller";
    readonly #sessionId: string;
    readonly #tools: readonly ExtensionWorkerToolDefinition[];
    readonly #controller = new AbortController();
    readonly #closedSignal: Promise<void>;
    readonly #resolveClosed: () => void;
    readonly #calls = new Set<Promise<JsonValue>>();
    #unwatch?: () => void;
    #closePromise?: Promise<void>;

    constructor(options: {
        ctxId?: string;
        extensionId: string;
        instance: Instance;
        opened: Awaited<ReturnType<Instance["openToolSession"]>>;
        onClosed(session: ExtensionWorkerSessionControl): void;
        recording: "host" | "caller";
        sessionId: string;
    }) {
        let resolveClosed: () => void = () => undefined;
        this.#closedSignal = new Promise<void>((resolve) => { resolveClosed = resolve; });
        this.#resolveClosed = () => resolveClosed();
        this.#instance = options.instance;
        this.instance = options.instance.config.name;
        this.environment = options.opened.environment;
        this.workspace = options.opened.workspace;
        this.#tools = options.opened.tools;
        this.#onClosed = options.onClosed;
        this.#ctxId = options.ctxId;
        this.#extensionId = options.extensionId;
        this.#recording = options.recording;
        this.#sessionId = options.sessionId;
    }

    get closed(): Promise<void> {
        return this.#closedSignal;
    }

    listTools(): readonly ExtensionWorkerToolDefinition[] {
        return this.#tools;
    }

    watchRetirement(): void {
        this.#unwatch = this.#instance.lifecycle.onRetiring(() => {
            void this.close().catch((error: unknown) =>
                console.warn(`Worker session retirement failed for ${this.instance}:`, error),
            );
        });
    }

    async callTool(
        toolName: string,
        input: ExtensionJsonValue,
        options: ExtensionWorkerCallOptions = {},
    ): Promise<ExtensionJsonValue> {
        this.#controller.signal.throwIfAborted();
        const signal = options.signal === undefined
            ? this.#controller.signal
            : AbortSignal.any([this.#controller.signal, options.signal]);
        const running = this.#instance.toolCallIngress.call(
            this.instance,
            toolName,
            input as JsonValue,
            {
                source: "extension",
                extensionId: this.#extensionId,
                workspace: this.workspace,
                ...(this.#ctxId === undefined ? {} : { ctxId: this.#ctxId }),
                ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
            },
            signal,
            undefined,
            undefined,
            options.onProgress,
            this.#recording,
        );
        this.#calls.add(running);
        try {
            return await running as ExtensionJsonValue;
        } finally {
            this.#calls.delete(running);
        }
    }

    abort(): void {
        this.#controller.abort(new Error("Extension Worker session closed."));
        this.#unwatch?.();
        this.#unwatch = undefined;
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#closePromise = Promise.resolve().then(async () => {
            await Promise.allSettled([...this.#calls]);
            await this.#instance.closeToolSession(this.#sessionId);
            this.#onClosed(this);
            this.#resolveClosed();
        }).catch((error: unknown) => {
            this.#closePromise = undefined;
            throw error;
        });
        this.abort();
        return this.#closePromise;
    }
}
