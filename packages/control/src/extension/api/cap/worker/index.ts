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
    readonly #sessions = new Set<ExtensionWorkerSessionControl>();
    readonly #opening = new Set<{ instance: string; promise: Promise<ExtensionWorkerSession> }>();
    readonly #retiring = new Set<string>();
    #closed = false;
    #closePromise?: Promise<void>;

    constructor(options: {
        allowed: boolean;
        extensionId: string;
        instances: InstanceRegistry;
        recording: "host" | "caller";
    }) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
        this.#recording = options.recording;
    }

    async openSession(input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession> {
        if (!this.#allowed)
            throw new Error(`Extension ${this.#extensionId} did not declare this Worker capability.`);
        if (this.#closed)
            throw new Error(`Extension ${this.#extensionId} Worker capability is closed.`);
        const instance = this.#resolve(input.instance);
        const promise = this.#open(instance, input.workspace);
        const pending = { instance: instance.config.name, promise };
        this.#opening.add(pending);
        try {
            return await promise;
        } finally {
            this.#opening.delete(pending);
        }
    }

    async retireInstance(instance: string): Promise<void> {
        this.#retiring.add(instance);
        try {
            await Promise.allSettled(
                [...this.#opening].filter((entry) => entry.instance === instance).map((entry) => entry.promise),
            );
            await closeSessions([...this.#sessions].filter((session) => session.instance === instance));
        } finally {
            this.#retiring.delete(instance);
        }
    }

    closeAll(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#closed = true;
        this.#closePromise = (async () => {
            await Promise.allSettled([...this.#opening].map((entry) => entry.promise));
            await closeSessions([...this.#sessions]);
        })();
        return this.#closePromise;
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

    async #open(instance: Instance, workspace: string): Promise<ExtensionWorkerSession> {
        const sessionId = randomUUID();
        const opened = await instance.openToolSession(workspace, sessionId);
        if (this.#closed || this.#retiring.has(instance.config.name) || !instance.lifecycle.active) {
            await instance.closeToolSession(sessionId);
            throw new Error(`Worker Instance ${instance.config.name} retired while opening a session.`);
        }
        const session = new ExtensionWorkerSessionControl({
            instance,
            opened,
            onClosed: (closed) => this.#sessions.delete(closed),
            recording: this.#recording,
            sessionId,
        });
        this.#sessions.add(session);
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
                workspace: this.workspace,
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

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#controller.abort(new Error("Extension Worker session closed."));
        this.#unwatch?.();
        this.#closePromise = (async () => {
            try {
                await Promise.allSettled([...this.#calls]);
                await this.#instance.closeToolSession(this.#sessionId);
            } finally {
                this.#onClosed(this);
                this.#resolveClosed();
            }
        })();
        return this.#closePromise;
    }
}

async function closeSessions(sessions: readonly ExtensionWorkerSessionControl[]): Promise<void> {
    const results = await Promise.allSettled(sessions.map(async (session) => await session.close()));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, "Extension Worker sessions failed to close.");
}
