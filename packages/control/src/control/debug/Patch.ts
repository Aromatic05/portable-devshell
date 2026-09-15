import { randomUUID } from "node:crypto";
import { createError, errorCodes } from "@portable-devshell/shared";
import type {
    DebugInvocationSummary,
    DebugPatchLoadRequest,
    DebugPatchScope,
    DebugPatchSummary,
    DebugTargetSummary,
    JsonValue,
} from "@portable-devshell/shared";
import { Worker } from "node:worker_threads";

export interface DebugMethodAdapter {
    project(args: readonly unknown[]): JsonValue;
    scope?(args: readonly unknown[]): DebugPatchScope | undefined;
    signal?(args: readonly unknown[]): AbortSignal | undefined;
}

interface DebugTarget {
    methods: Readonly<Record<string, DebugMethodAdapter>>;
    object: object;
}

interface MethodPatch {
    method: string;
    original: (...args: unknown[]) => unknown;
    ownDescriptor?: PropertyDescriptor;
    wrapper: (...args: unknown[]) => unknown;
}

interface HoldState {
    release(): void;
}

interface ActivePatch {
    holds: Map<string, HoldState>;
    methods: MethodPatch[];
    program: DebugPatchProgram;
    summary: DebugPatchSummary;
    target: DebugTarget;
}

type DebugDirective =
    | { action: "continue" }
    | { action: "error"; message: string }
    | { action: "hold"; label?: string }
    | { action: "return"; value: JsonValue };

export interface DebugPatchManagerOptions {
    evaluationTimeoutMs?: number;
    historyLimit?: number;
    initializationTimeoutMs?: number;
}

export class DebugPatchManager {
    readonly #active = new Map<string, ActivePatch>();
    readonly #closingPrograms = new Set<Promise<void>>();
    readonly #evaluationTimeoutMs: number;
    readonly #history: DebugPatchSummary[] = [];
    readonly #historyLimit: number;
    readonly #initializationTimeoutMs: number;
    readonly #targetPatch = new Map<string, string>();
    readonly #targets = new Map<string, DebugTarget>();

    constructor(options: DebugPatchManagerOptions = {}) {
        this.#evaluationTimeoutMs = options.evaluationTimeoutMs ?? 1_000;
        this.#historyLimit = options.historyLimit ?? 32;
        this.#initializationTimeoutMs =
            options.initializationTimeoutMs ?? 1_000;
    }

    registerTarget(
        name: string,
        object: object,
        methods: Readonly<Record<string, DebugMethodAdapter>>,
    ): void {
        if (name.length === 0 || Object.keys(methods).length === 0) {
            throw invalidPatch("Debug target name and methods are required.");
        }
        const previous = this.#targets.get(name);
        if (previous?.object === object) return;
        if (previous !== undefined) {
            throw invalidPatch(
                `Debug target ${name} is already registered with another object.`,
            );
        }
        this.#targets.set(name, { methods, object });
    }

    async unregisterTarget(name: string): Promise<void> {
        const patchId = this.#targetPatch.get(name);
        if (patchId !== undefined) await this.unload(patchId);
        this.#targets.delete(name);
    }

    listTargets(): DebugTargetSummary[] {
        return [...this.#targets.entries()]
            .map(([target, value]) => ({
                methods: Object.keys(value.methods).sort(),
                target,
            }))
            .sort((left, right) => left.target.localeCompare(right.target));
    }

    listPatches(): DebugPatchSummary[] {
        return [
            ...[...this.#active.values()].map((entry) =>
                cloneSummary(entry.summary),
            ),
            ...this.#history.map(cloneSummary),
        ];
    }

    async load(request: DebugPatchLoadRequest): Promise<DebugPatchSummary> {
        const target = this.#targets.get(request.target);
        if (target === undefined) {
            throw createError({
                code: errorCodes.controlDebugTargetNotFound,
                message: `Debug target ${request.target} is not registered.`,
                retryable: false,
            });
        }
        if (this.#targetPatch.has(request.target)) {
            throw invalidPatch(
                `Debug target ${request.target} already has an active patch.`,
            );
        }
        if (Buffer.byteLength(request.source, "utf8") > 64 * 1024) {
            throw invalidPatch("Debug patch source must not exceed 64 KiB.");
        }
        if (request.scope !== undefined) {
            if (request.scope.ctxId.length === 0) {
                throw invalidPatch(
                    "Debug patch scope ctxId must be non-empty.",
                );
            }
            if (
                request.scope.toolName !== undefined &&
                request.scope.toolName.length === 0
            ) {
                throw invalidPatch(
                    "Debug patch scope toolName must be non-empty when supplied.",
                );
            }
            const unsupported = Object.entries(target.methods).find(
                ([, adapter]) => adapter.scope === undefined,
            );
            if (unsupported !== undefined) {
                throw invalidPatch(
                    `Debug target ${request.target} method ${unsupported[0]} does not support scoped patches.`,
                );
            }
        }

        const patchId = `debug-${randomUUID()}`;
        const summary: DebugPatchSummary = {
            invocationCount: 0,
            loadedAt: new Date().toISOString(),
            ...(request.name === undefined ? {} : { name: request.name }),
            patchId,
            ...(request.scope === undefined
                ? {}
                : { scope: { ...request.scope } }),
            state: "active",
            target: request.target,
        };
        const program = new DebugPatchProgram(request.source, {
            evaluationTimeoutMs: this.#evaluationTimeoutMs,
            initializationTimeoutMs: this.#initializationTimeoutMs,
            onFault: (error) => {
                void this.#fault(patchId, error);
            },
        });
        await program.start().catch(async (error) => {
            await program.close();
            throw invalidPatch(
                `Debug patch failed to initialize: ${errorMessage(error)}`,
            );
        });

        const active: ActivePatch = {
            holds: new Map(),
            methods: [],
            program,
            summary,
            target,
        };
        try {
            for (const method of Object.keys(target.methods)) {
                active.methods.push(this.#installMethod(active, method));
            }
        } catch (error) {
            this.#restoreMethods(active);
            await program.close();
            throw invalidPatch(
                `Debug patch could not be installed: ${errorMessage(error)}`,
            );
        }
        this.#active.set(patchId, active);
        this.#targetPatch.set(request.target, patchId);
        return cloneSummary(summary);
    }

    async unload(patchId: string): Promise<DebugPatchSummary> {
        const active = this.#active.get(patchId);
        if (active === undefined) {
            const terminal = this.#history.find(
                (entry) => entry.patchId === patchId,
            );
            if (terminal !== undefined) return cloneSummary(terminal);
            throw patchNotFound(patchId);
        }
        return await this.#deactivate(active, "unloaded");
    }

    release(patchId: string): DebugPatchSummary {
        const active = this.#active.get(patchId);
        if (active === undefined) throw patchNotFound(patchId);
        for (const hold of [...active.holds.values()]) hold.release();
        return cloneSummary(active.summary);
    }

    async dispose(): Promise<void> {
        for (const patchId of [...this.#active.keys()]) {
            await this.unload(patchId).catch(() => undefined);
        }
        this.#targets.clear();
        await Promise.all([...this.#closingPrograms]);
    }

    #installMethod(active: ActivePatch, method: string): MethodPatch {
        const adapter = active.target.methods[method];
        if (adapter === undefined)
            throw new Error(`Missing adapter for ${method}.`);
        const originalValue = Reflect.get(active.target.object, method);
        if (typeof originalValue !== "function") {
            throw new TypeError(
                `Debug target method ${method} is not callable.`,
            );
        }
        const original = originalValue as (...args: unknown[]) => unknown;
        const ownDescriptor = Object.getOwnPropertyDescriptor(
            active.target.object,
            method,
        );
        const invoke = this.#invoke.bind(this);
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            return invoke(active.summary.patchId, method, original, this, args);
        };
        Object.defineProperty(active.target.object, method, {
            configurable: true,
            enumerable: ownDescriptor?.enumerable ?? false,
            value: wrapper,
            writable: true,
        });
        return { method, original, ownDescriptor, wrapper };
    }

    async #invoke(
        patchId: string,
        method: string,
        original: (...args: unknown[]) => unknown,
        receiver: unknown,
        args: unknown[],
    ): Promise<unknown> {
        const active = this.#active.get(patchId);
        if (active === undefined)
            return await Reflect.apply(original, receiver, args);
        const adapter = active.target.methods[method];
        if (adapter === undefined)
            return await Reflect.apply(original, receiver, args);
        if (active.summary.scope !== undefined) {
            const actualScope = adapter.scope?.(args);
            if (!matchesScope(active.summary.scope, actualScope)) {
                return await Reflect.apply(original, receiver, args);
            }
        }
        const invocation: DebugInvocationSummary = {
            invocationId: `debug-call-${randomUUID()}`,
            method,
            outcome: "continued",
            startedAt: new Date().toISOString(),
        };
        active.summary.invocationCount += 1;
        this.#rememberInvocation(active, invocation);

        let directive: DebugDirective;
        try {
            directive = readDirective(
                await active.program.evaluate({
                    args: adapter.project(args),
                    method,
                    patchId,
                    target: active.summary.target,
                }),
            );
        } catch (error) {
            invocation.outcome = "faulted";
            invocation.completedAt = new Date().toISOString();
            this.#rememberInvocation(active, invocation);
            await this.#fault(patchId, error);
            return await Reflect.apply(original, receiver, args);
        }

        if (directive.action === "continue") {
            invocation.outcome = "continued";
            invocation.completedAt = new Date().toISOString();
            this.#rememberInvocation(active, invocation);
            return await Reflect.apply(original, receiver, args);
        }
        if (directive.action === "return") {
            invocation.outcome = "returned";
            invocation.completedAt = new Date().toISOString();
            this.#rememberInvocation(active, invocation);
            return directive.value;
        }
        if (directive.action === "error") {
            invocation.outcome = "thrown";
            invocation.completedAt = new Date().toISOString();
            this.#rememberInvocation(active, invocation);
            throw new Error(directive.message);
        }

        invocation.outcome = "holding";
        if (directive.label !== undefined) invocation.label = directive.label;
        this.#rememberInvocation(active, invocation);
        const signal = adapter.signal?.(args);
        try {
            await this.#hold(active, invocation, signal);
        } catch (error) {
            invocation.outcome = "aborted";
            invocation.completedAt = new Date().toISOString();
            this.#rememberInvocation(active, invocation);
            throw error;
        }
        invocation.outcome = "released";
        invocation.completedAt = new Date().toISOString();
        this.#rememberInvocation(active, invocation);
        return await Reflect.apply(original, receiver, args);
    }

    async #hold(
        active: ActivePatch,
        invocation: DebugInvocationSummary,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        if (signal?.aborted === true) throw abortReason(signal);
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => signal?.removeEventListener("abort", aborted);
            const finish = (operation: () => void) => {
                if (settled) return;
                settled = true;
                active.holds.delete(invocation.invocationId);
                cleanup();
                operation();
            };
            const aborted = () => finish(() => reject(abortReason(signal!)));
            const release = () => finish(resolve);
            active.holds.set(invocation.invocationId, { release });
            signal?.addEventListener("abort", aborted, { once: true });
            if (signal?.aborted === true) aborted();
        });
    }

    async #fault(patchId: string, error: unknown): Promise<void> {
        const active = this.#active.get(patchId);
        if (active === undefined) return;
        await this.#deactivate(active, "faulted", errorMessage(error));
    }

    async #deactivate(
        active: ActivePatch,
        state: "faulted" | "unloaded",
        fault?: string,
    ): Promise<DebugPatchSummary> {
        if (!this.#active.delete(active.summary.patchId))
            return cloneSummary(active.summary);
        this.#targetPatch.delete(active.summary.target);
        this.#restoreMethods(active);
        for (const hold of [...active.holds.values()]) hold.release();
        active.holds.clear();
        active.summary.state = state;
        active.summary.unloadedAt = new Date().toISOString();
        if (fault !== undefined) active.summary.fault = fault;
        this.#history.unshift(cloneSummary(active.summary));
        this.#history.splice(this.#historyLimit);
        this.#scheduleProgramClose(active.program);
        return cloneSummary(active.summary);
    }

    #restoreMethods(active: ActivePatch): void {
        for (const patched of [...active.methods].reverse()) {
            const current = Object.getOwnPropertyDescriptor(
                active.target.object,
                patched.method,
            );
            if (current?.value !== patched.wrapper) continue;
            if (patched.ownDescriptor === undefined) {
                Reflect.deleteProperty(active.target.object, patched.method);
            } else {
                Object.defineProperty(
                    active.target.object,
                    patched.method,
                    patched.ownDescriptor,
                );
            }
        }
        active.methods.length = 0;
    }

    #rememberInvocation(
        active: ActivePatch,
        invocation: DebugInvocationSummary,
    ): void {
        active.summary.lastInvocation = { ...invocation };
    }

    #scheduleProgramClose(program: DebugPatchProgram): void {
        const closing = program.close();
        this.#closingPrograms.add(closing);
        void closing.finally(() => this.#closingPrograms.delete(closing));
    }
}

function readDirective(value: unknown): DebugDirective {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidPatch("Debug patch must return a directive object.");
    }
    const directive = value as Record<string, unknown>;
    if (directive.action === "continue") return { action: "continue" };
    if (directive.action === "hold") {
        if (
            directive.label !== undefined &&
            typeof directive.label !== "string"
        ) {
            throw invalidPatch("Debug hold label must be a string.");
        }
        return {
            action: "hold",
            ...(directive.label === undefined
                ? {}
                : { label: directive.label }),
        };
    }
    if (directive.action === "return") {
        if (!("value" in directive))
            throw invalidPatch("Debug return directive requires value.");
        return { action: "return", value: cloneJsonValue(directive.value) };
    }
    if (directive.action === "error" && typeof directive.message === "string") {
        return { action: "error", message: directive.message };
    }
    throw invalidPatch("Debug patch returned an unsupported directive.");
}

function cloneJsonValue(value: unknown): JsonValue {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined)
            throw new Error("value is not JSON serializable");
        return JSON.parse(serialized) as JsonValue;
    } catch (error) {
        throw invalidPatch(
            `Debug return value must be JSON serializable: ${errorMessage(error)}`,
        );
    }
}

function invalidPatch(message: string) {
    return createError({
        code: errorCodes.controlDebugPatchInvalid,
        message,
        retryable: false,
    });
}

function patchNotFound(patchId: string) {
    return createError({
        code: errorCodes.controlDebugPatchNotFound,
        message: `Debug patch ${patchId} was not found.`,
        retryable: false,
    });
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason ?? "Debug hold aborted."));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function matchesScope(
    expected: DebugPatchScope,
    actual: DebugPatchScope | undefined,
): boolean {
    if (actual?.ctxId !== expected.ctxId) return false;
    return (
        expected.toolName === undefined || actual.toolName === expected.toolName
    );
}

function cloneSummary(summary: DebugPatchSummary): DebugPatchSummary {
    return {
        ...summary,
        ...(summary.scope === undefined ? {} : { scope: { ...summary.scope } }),
        ...(summary.lastInvocation === undefined
            ? {}
            : { lastInvocation: { ...summary.lastInvocation } }),
    };
}

interface DebugPatchProgramOptions {
    evaluationTimeoutMs: number;
    initializationTimeoutMs: number;
    onFault?(error: Error): void;
}

interface PendingEvaluation {
    reject(error: Error): void;
    resolve(value: JsonValue): void;
    timer: NodeJS.Timeout;
}

type WorkerMessage =
    | { error: string; type: "initError" }
    | { type: "ready" }
    | { error: string; id: string; type: "resultError" }
    | { id: string; type: "result"; value: JsonValue };

const DEBUG_WORKER_SOURCE = String.raw`
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");

const errorText = (error) => error instanceof Error
    ? (error.stack || error.message)
    : String(error);

try {
    const context = vm.createContext(Object.create(null), {
        codeGeneration: { strings: true, wasm: false },
        name: "portable-devshell-debug"
    });
    const install = new vm.Script('"use strict";(' + workerData.source + ')', {
        filename: "devshell-debug-patch.js"
    });
    const hook = install.runInContext(context, { timeout: workerData.vmTimeoutMs });
    if (typeof hook !== "function") {
        throw new TypeError("Debug patch source must evaluate to a function.");
    }
    Object.defineProperty(context, "__debugHook", { value: hook, configurable: false });
    parentPort.postMessage({ type: "ready" });
    parentPort.on("message", async (message) => {
        if (message?.type !== "evaluate") return;
        try {
            Object.defineProperty(context, "__debugEvent", {
                configurable: true,
                value: message.event
            });
            const invoke = new vm.Script("__debugHook(__debugEvent)", {
                filename: "devshell-debug-invocation.js"
            });
            const value = await invoke.runInContext(context, { timeout: workerData.vmTimeoutMs });
            parentPort.postMessage({ id: message.id, type: "result", value });
        } catch (error) {
            parentPort.postMessage({ id: message.id, type: "resultError", error: errorText(error) });
        }
    });
} catch (error) {
    parentPort.postMessage({ type: "initError", error: errorText(error) });
}
`;

const DEBUG_WORKER_TERMINATE_WAIT_MS = 1_000;

export class DebugPatchProgram {
    readonly #evaluationTimeoutMs: number;
    readonly #initializationTimeoutMs: number;
    readonly #onFault?: (error: Error) => void;
    readonly #pending = new Map<string, PendingEvaluation>();
    readonly #ready: Promise<void>;
    readonly #worker: Worker;
    #closing = false;
    #faulted = false;

    constructor(source: string, options: DebugPatchProgramOptions) {
        this.#evaluationTimeoutMs = options.evaluationTimeoutMs;
        this.#initializationTimeoutMs = options.initializationTimeoutMs;
        this.#onFault = options.onFault;
        this.#worker = new Worker(DEBUG_WORKER_SOURCE, {
            eval: true,
            resourceLimits: {
                maxOldGenerationSizeMb: 16,
                maxYoungGenerationSizeMb: 4,
                stackSizeMb: 2,
            },
            workerData: {
                source,
                vmTimeoutMs: options.evaluationTimeoutMs,
            },
        });
        this.#ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(
                    `Debug patch initialization timed out after ${this.#initializationTimeoutMs}ms.`,
                );
                reject(error);
                this.#fault(error);
            }, this.#initializationTimeoutMs);
            const ready = (message: WorkerMessage) => {
                if (message.type === "ready") {
                    clearTimeout(timer);
                    this.#worker.off("message", ready);
                    resolve();
                    return;
                }
                if (message.type === "initError") {
                    clearTimeout(timer);
                    this.#worker.off("message", ready);
                    const error = new Error(message.error);
                    reject(error);
                    this.#fault(error);
                }
            };
            this.#worker.on("message", ready);
        });
        this.#worker.on("message", (message: WorkerMessage) =>
            this.#accept(message),
        );
        this.#worker.on("error", (error) => this.#fault(error));
        this.#worker.on("exit", (code) => {
            if (!this.#closing && !this.#faulted) {
                this.#fault(
                    new Error(
                        `Debug patch worker exited unexpectedly with code ${code}.`,
                    ),
                );
            }
        });
    }

    async start(): Promise<void> {
        await this.#ready;
    }

    async evaluate(event: JsonValue): Promise<JsonValue> {
        await this.#ready;
        if (this.#faulted || this.#closing) {
            throw new Error("Debug patch worker is not available.");
        }
        const id = randomUUID();
        return await new Promise<JsonValue>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.#pending.delete(id)) return;
                const error = new Error(
                    `Debug patch evaluation timed out after ${this.#evaluationTimeoutMs}ms.`,
                );
                reject(error);
                this.#fault(error);
            }, this.#evaluationTimeoutMs);
            this.#pending.set(id, { reject, resolve, timer });
            try {
                this.#worker.postMessage({ event, id, type: "evaluate" });
            } catch (error) {
                clearTimeout(timer);
                this.#pending.delete(id);
                const failure = toError(error);
                reject(failure);
                this.#fault(failure);
            }
        });
    }

    async close(): Promise<void> {
        if (this.#closing) return;
        this.#closing = true;
        const error = new Error("Debug patch worker was unloaded.");
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        this.#worker.unref();
        const terminated = this.#worker.terminate().then(
            () => undefined,
            () => undefined,
        );
        await Promise.race([terminated, delay(DEBUG_WORKER_TERMINATE_WAIT_MS)]);
    }

    #accept(message: WorkerMessage): void {
        if (message.type !== "result" && message.type !== "resultError") return;
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === "result") {
            pending.resolve(message.value);
            return;
        }
        pending.reject(new Error(message.error));
    }

    #fault(error: Error): void {
        if (this.#faulted || this.#closing) return;
        this.#faulted = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        void this.#worker.terminate().catch(() => undefined);
        this.#onFault?.(error);
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}
