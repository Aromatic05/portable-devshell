import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionProcessStartInput,
} from "@portable-devshell/extension/process";

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
                ? ["ignore", "pipe", "pipe", "ipc"]
                : ["ignore", "pipe", "pipe"],
        });
        const managed = new ManagedExtensionProcess(child, normalized.messages);
        this.#processes.add(managed);
        void managed.closed.finally(() => this.#processes.delete(managed));
        await managed.started;
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
    readonly #stdoutListeners = new Set<(chunk: string) => void>();
    readonly closed: Promise<ExtensionProcessExit>;
    readonly started: Promise<void>;
    #closed = false;
    #rejectStarted!: (error: unknown) => void;
    #resolveClosed!: (exit: ExtensionProcessExit) => void;
    #resolveStarted!: () => void;
    #spawned = false;
    #stderrObserved = false;
    #stdoutObserved = false;
    #terminatePromise?: Promise<void>;

    constructor(child: ChildProcess, messages: boolean) {
        this.#child = child;
        this.#messages = messages;
        this.closed = new Promise<ExtensionProcessExit>((resolve) => {
            this.#resolveClosed = resolve;
        });
        this.started = new Promise<void>((resolve, reject) => {
            this.#resolveStarted = resolve;
            this.#rejectStarted = reject;
        });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
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
        child.once("spawn", () => {
            this.#spawned = true;
            this.#resolveStarted();
        });
        child.once("error", (error) => {
            if (!this.#spawned) this.#rejectStarted(error);
            this.#settle({});
        });
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
        if (!this.#stderrObserved) {
            this.#stderrObserved = true;
            this.#child.stderr?.on("data", (chunk: string) => {
                for (const candidate of this.#stderrListeners) candidate(chunk);
            });
        }
        return () => this.#stderrListeners.delete(listener);
    }

    onStdout(listener: (chunk: string) => void): () => void {
        this.#stdoutListeners.add(listener);
        if (!this.#stdoutObserved) {
            this.#stdoutObserved = true;
            this.#child.stdout?.on("data", (chunk: string) => {
                for (const candidate of this.#stdoutListeners) candidate(chunk);
            });
        }
        return () => this.#stdoutListeners.delete(listener);
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
        this.#stdoutListeners.clear();
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
