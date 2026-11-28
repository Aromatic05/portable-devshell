import { inspect } from "node:util";

import type {
    CodeLogEntry,
    CodeLogLevel,
    JsonValue,
} from "@portable-devshell/shared";
import {
    controlErrorCodes,
    createRemoteError,
} from "@portable-devshell/shared";
import {
    EvalFlags,
    newQuickJSWASMModuleFromVariant,
    type QuickJSContext,
    type QuickJSDeferredPromise,
    type QuickJSHandle,
    type QuickJSRuntime,
    type QuickJSWASMModule,
} from "quickjs-emscripten";

import { buildBootstrapScript, type CodeBootstrapCatalog } from "../model/Bridge.js";

const JS_EVAL_FLAG_ASYNC = 1 << 7; // QuickJS-NG native top-level await + completion value

export interface QuickJsEngineLimits {
    readonly maxConcurrentCalls: number;
    readonly maxLogBytes: number;
    readonly maxMemoryBytes: number;
    readonly maxStackBytes: number;
    readonly maxTimeoutMs: number;
    readonly maxValueBytes: number;
    readonly defaultTimeoutMs: number;
}

export const DEFAULT_QUICKJS_LIMITS: QuickJsEngineLimits = Object.freeze({
    defaultTimeoutMs: 120_000,
    maxConcurrentCalls: 16,
    maxLogBytes: 256 * 1024,
    maxMemoryBytes: 64 * 1024 * 1024,
    maxStackBytes: 512 * 1024,
    maxTimeoutMs: 600_000,
    maxValueBytes: 256 * 1024,
});

export interface QuickJsHostBridge {
    readonly catalog: CodeBootstrapCatalog;
    help(target?: string, filter?: string): string;
    invoke(request: {
        input: JsonValue;
        instance?: string;
        method: string;
        objectId: string;
        signal: AbortSignal;
        workspace?: string;
    }): Promise<JsonValue | undefined>;
    invokeHandle(request: {
        handleId: string;
        input: JsonValue;
        method: string;
        objectId: string;
        signal: AbortSignal;
    }): Promise<JsonValue | undefined>;
    openHandle(request: {
        instance?: string;
        objectId: string;
        signal: AbortSignal;
        target: JsonValue;
        workspace?: string;
    }): Promise<string>;
    ready(request: {
        instance?: string;
        signal: AbortSignal;
        workspace?: string;
    }): Promise<JsonValue>;
}

export interface QuickJsEvalInput {
    readonly bridge: QuickJsHostBridge;
    readonly filename?: string;
    readonly limits?: Partial<QuickJsEngineLimits>;
    readonly onLog?: (entry: CodeLogEntry) => void;
    readonly signal?: AbortSignal;
    readonly source: string;
    readonly timeoutMs?: number;
}

export interface QuickJsEvalOutput {
    readonly durationMs: number;
    readonly hasValue: boolean;
    readonly logs: readonly CodeLogEntry[];
    readonly toolCalls: number;
    readonly truncatedLogs: boolean;
    readonly truncatedValue: boolean;
    readonly value?: JsonValue;
}

let cachedModulePromise: Promise<QuickJSWASMModule> | undefined;

async function loadQuickJsModule(): Promise<QuickJSWASMModule> {
    if (cachedModulePromise === undefined) {
        cachedModulePromise = newQuickJSWASMModuleFromVariant(
            import("@jitl/quickjs-ng-wasmfile-release-sync") as never,
        ).catch((error: unknown) => {
            cachedModulePromise = undefined;
            throw error;
        });
    }
    return await cachedModulePromise;
}

export class QuickJsEngine {
    readonly #limits: QuickJsEngineLimits;

    constructor(limits: Partial<QuickJsEngineLimits> = {}) {
        this.#limits = Object.freeze({
            ...DEFAULT_QUICKJS_LIMITS,
            ...limits,
        });
    }

    async evaluate(input: QuickJsEvalInput): Promise<QuickJsEvalOutput> {
        const startedAt = Date.now();
        const limits: QuickJsEngineLimits = {
            ...this.#limits,
            ...input.limits,
        };
        const timeoutMs = clampTimeout(input.timeoutMs, limits);
        const filename = input.filename ?? "<eval>.js";

        const executionController = new AbortController();
        let timedOut = false;
        let cancelled = false;
        const onOuterAbort = () => {
            cancelled = true;
            executionController.abort(
                input.signal?.reason ?? new Error("Code execution was cancelled."),
            );
        };
        if (input.signal?.aborted === true) {
            throw createRemoteError({
                code: controlErrorCodes.codeEvalCancelled,
                message: "Code execution was cancelled.",
                retryable: false,
            });
        }
        input.signal?.addEventListener("abort", onOuterAbort, { once: true });

        const deadlineMs = Date.now() + timeoutMs;
        const timer = setTimeout(() => {
            timedOut = true;
            executionController.abort(
                new Error(`Code execution timed out after ${timeoutMs}ms.`),
            );
        }, timeoutMs);
        timer.unref?.();

        const module = await loadQuickJsModule();
        const runtime = module.newRuntime();
        runtime.setMemoryLimit(limits.maxMemoryBytes);
        runtime.setMaxStackSize(limits.maxStackBytes);
        runtime.setInterruptHandler(() => {
            if (Date.now() >= deadlineMs) {
                timedOut = true;
                return true;
            }
            return timedOut || cancelled;
        });

        const vm = runtime.newContext();
        const logs: CodeLogEntry[] = [];
        let logBytes = 0;
        let truncatedLogs = false;
        let toolCalls = 0;
        let inFlight = 0;
        let disposed = false;

        const activeDeferreds = new Set<QuickJSDeferredPromise>();
        const activeTimers = new Set<ReturnType<typeof setTimeout>>();

        let notifyWaiter: (() => void) | undefined;
        const wake = () => {
            const cb = notifyWaiter;
            notifyWaiter = undefined;
            cb?.();
        };

        const onExecutionAbort = () => wake();
        executionController.signal.addEventListener("abort", onExecutionAbort, {
            once: true,
        });

        const emitLog = (level: CodeLogLevel, text: string) => {
            const bytes = Buffer.byteLength(text, "utf8");
            if (logBytes + bytes > limits.maxLogBytes) {
                truncatedLogs = true;
                return;
            }
            logBytes += bytes;
            const entry: CodeLogEntry = {
                level,
                text,
                timestampMs: Date.now(),
            };
            logs.push(entry);
            input.onLog?.(entry);
        };

        const bridgeAsync = (
            operation: () => Promise<JsonValue | undefined>,
            countAsCall: boolean,
        ): QuickJSHandle => {
            if (inFlight >= limits.maxConcurrentCalls) {
                throw new Error(
                    `Maximum concurrent calls (${limits.maxConcurrentCalls}) exceeded.`,
                );
            }
            const deferred = vm.newPromise();
            activeDeferreds.add(deferred);
            inFlight += 1;
            if (countAsCall) toolCalls += 1;

            void Promise.resolve()
                .then(operation)
                .then(
                    (result) => {
                        inFlight = Math.max(0, inFlight - 1);
                        activeDeferreds.delete(deferred);
                        if (disposed || executionController.signal.aborted) {
                            deferred.dispose();
                            wake();
                            return;
                        }
                        try {
                            const handle = toQuickJsHandle(vm, result);
                            deferred.resolve(handle);
                            handle.dispose();
                        } catch (error) {
                            const errHandle = vm.newError(toErrorMessage(error));
                            deferred.reject(errHandle);
                            errHandle.dispose();
                        } finally {
                            deferred.dispose();
                            drainPendingJobs(runtime);
                            wake();
                        }
                    },
                    (error: unknown) => {
                        inFlight = Math.max(0, inFlight - 1);
                        activeDeferreds.delete(deferred);
                        if (disposed || executionController.signal.aborted) {
                            deferred.dispose();
                            wake();
                            return;
                        }
                        const errHandle = vm.newError(toErrorMessage(error));
                        deferred.reject(errHandle);
                        errHandle.dispose();
                        deferred.dispose();
                        drainPendingJobs(runtime);
                        wake();
                    },
                );
            return deferred.handle;
        };

        try {
            installHostPrimitives(vm, {
                bridge: input.bridge,
                bridgeAsync,
                emitLog,
                limits,
                registerTimer: (t) => activeTimers.add(t),
                unregisterTimer: (t) => activeTimers.delete(t),
                signal: executionController.signal,
            });

            const bootstrap = buildBootstrapScript(input.bridge.catalog);
            const bootResult = vm.evalCode(
                bootstrap,
                "<devshell-bootstrap>.js",
                EvalFlags.JS_EVAL_TYPE_GLOBAL | EvalFlags.JS_EVAL_FLAG_STRICT,
            );
            if (bootResult.error !== undefined) {
                const detail = formatQuickJsError(vm, bootResult.error);
                bootResult.error.dispose();
                throw new Error(`DevShell runtime bootstrap failed: ${detail}`);
            }
            bootResult.value.dispose();

            const evaluated = evaluateUserSource(vm, input.source, filename);
            if (evaluated.error !== undefined) {
                const err = evaluated.error;
                const message = formatQuickJsError(vm, err);
                err.dispose();
                if (timedOut) throw timeoutError(timeoutMs);
                if (cancelled) throw cancelledError();
                throw evalFailedError(message);
            }

            const promiseHandle = evaluated.value;
            try {
                while (true) {
                    drainPendingJobs(runtime);
                    if (timedOut) throw timeoutError(timeoutMs);
                    if (cancelled) throw cancelledError();

                    const state = vm.getPromiseState(promiseHandle);
                    if (state.type === "fulfilled") {
                        const raw = extractCompletionValue(
                            vm,
                            state.value,
                            evaluated.unwrapValueProp,
                        );
                        state.value.dispose();
                        const serialized = serializeFinalValue(
                            raw,
                            limits.maxValueBytes,
                        );
                        return {
                            durationMs: Date.now() - startedAt,
                            hasValue: serialized.hasValue,
                            logs,
                            toolCalls,
                            truncatedLogs,
                            truncatedValue: serialized.truncated,
                            ...(serialized.hasValue ? { value: serialized.value } : {}),
                        };
                    }
                    if (state.type === "rejected") {
                        const message = formatQuickJsError(vm, state.error);
                        state.error.dispose();
                        if (timedOut) throw timeoutError(timeoutMs);
                        if (cancelled) throw cancelledError();
                        throw evalFailedError(message);
                    }
                    if (inFlight === 0 && activeTimers.size === 0) {
                        throw evalFailedError(
                            "Script returned an unresolved Promise with no pending host operations.",
                        );
                    }
                    await new Promise<void>((resolve) => {
                        notifyWaiter = resolve;
                    });
                }
            } finally {
                promiseHandle.dispose();
            }
        } finally {
            disposed = true;
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", onOuterAbort);
            executionController.signal.removeEventListener("abort", onExecutionAbort);
            for (const activeTimer of activeTimers) clearTimeout(activeTimer);
            activeTimers.clear();
            for (const deferred of activeDeferreds) deferred.dispose();
            activeDeferreds.clear();
            vm.dispose();
            runtime.dispose();
        }
    }
}

function installHostPrimitives(
    vm: QuickJSContext,
    options: {
        bridge: QuickJsHostBridge;
        bridgeAsync: (
            operation: () => Promise<JsonValue | undefined>,
            countAsCall: boolean,
        ) => QuickJSHandle;
        emitLog: (level: CodeLogLevel, text: string) => void;
        limits: QuickJsEngineLimits;
        registerTimer: (timer: ReturnType<typeof setTimeout>) => void;
        signal: AbortSignal;
        unregisterTimer: (timer: ReturnType<typeof setTimeout>) => void;
    },
): void {
    const hostObj = vm.newObject();

    const logFn = vm.newFunction("log", (levelHandle, argsHandle) => {
        const level = vm.getString(levelHandle) as CodeLogLevel;
        const dumped = vm.dump(argsHandle);
        const parts = Array.isArray(dumped) ? dumped : [dumped];
        const text = parts
            .map((part) =>
                typeof part === "string"
                    ? part
                    : inspect(part, { colors: false, depth: 6, breakLength: 100 }),
            )
            .join(" ");
        options.emitLog(level, text);
    });
    vm.setProp(hostObj, "log", logFn);
    logFn.dispose();

    const helpFn = vm.newFunction("help", (targetHandle, filterHandle) => {
        const target =
            targetHandle === undefined || vm.typeof(targetHandle) === "undefined"
                ? undefined
                : vm.getString(targetHandle);
        const filter =
            filterHandle === undefined || vm.typeof(filterHandle) === "undefined"
                ? undefined
                : vm.getString(filterHandle);
        return vm.newString(options.bridge.help(target, filter));
    });
    vm.setProp(hostObj, "help", helpFn);
    helpFn.dispose();

    const invokeFn = vm.newFunction("invoke", (payloadHandle) => {
        const payload = vm.dump(payloadHandle) as {
            input?: JsonValue;
            instance?: string;
            method: string;
            objectId: string;
            workspace?: string;
        };
        return options.bridgeAsync(
            async () =>
                await options.bridge.invoke({
                    input: payload.input ?? {},
                    ...(payload.instance === undefined ? {} : { instance: payload.instance }),
                    method: payload.method,
                    objectId: payload.objectId,
                    signal: options.signal,
                    ...(payload.workspace === undefined ? {} : { workspace: payload.workspace }),
                }),
            true,
        );
    });
    vm.setProp(hostObj, "invoke", invokeFn);
    invokeFn.dispose();

    const openHandleFn = vm.newFunction("openHandle", (payloadHandle) => {
        const payload = vm.dump(payloadHandle) as {
            instance?: string;
            objectId: string;
            target?: JsonValue;
            workspace?: string;
        };
        return options.bridgeAsync(
            async () =>
                await options.bridge.openHandle({
                    ...(payload.instance === undefined ? {} : { instance: payload.instance }),
                    objectId: payload.objectId,
                    signal: options.signal,
                    target: payload.target ?? {},
                    ...(payload.workspace === undefined ? {} : { workspace: payload.workspace }),
                }),
            false,
        );
    });
    vm.setProp(hostObj, "openHandle", openHandleFn);
    openHandleFn.dispose();

    const invokeHandleFn = vm.newFunction("invokeHandle", (payloadHandle) => {
        const payload = vm.dump(payloadHandle) as {
            handleId: string;
            input?: JsonValue;
            method: string;
            objectId: string;
        };
        return options.bridgeAsync(
            async () =>
                await options.bridge.invokeHandle({
                    handleId: payload.handleId,
                    input: payload.input ?? {},
                    method: payload.method,
                    objectId: payload.objectId,
                    signal: options.signal,
                }),
            true,
        );
    });
    vm.setProp(hostObj, "invokeHandle", invokeHandleFn);
    invokeHandleFn.dispose();

    const readyFn = vm.newFunction("ready", (payloadHandle) => {
        const payload = vm.dump(payloadHandle) as {
            instance?: string;
            workspace?: string;
        };
        return options.bridgeAsync(
            async () =>
                await options.bridge.ready({
                    ...(payload.instance === undefined ? {} : { instance: payload.instance }),
                    signal: options.signal,
                    ...(payload.workspace === undefined ? {} : { workspace: payload.workspace }),
                }),
            false,
        );
    });
    vm.setProp(hostObj, "ready", readyFn);
    readyFn.dispose();

    const sleepFn = vm.newFunction("sleep", (msHandle) => {
        const rawMs = vm.getNumber(msHandle);
        const ms = Number.isFinite(rawMs) && rawMs > 0 ? Math.min(rawMs, options.limits.maxTimeoutMs) : 0;
        return options.bridgeAsync(
            () =>
                new Promise<undefined>((resolve, reject) => {
                    if (options.signal.aborted) {
                        reject(new Error("sleep aborted"));
                        return;
                    }
                    const onAbort = () => {
                        clearTimeout(t);
                        options.unregisterTimer(t);
                        reject(new Error("sleep aborted"));
                    };
                    const t = setTimeout(() => {
                        options.signal.removeEventListener("abort", onAbort);
                        options.unregisterTimer(t);
                        resolve(undefined);
                    }, ms);
                    t.unref?.();
                    options.registerTimer(t);
                    options.signal.addEventListener("abort", onAbort, { once: true });
                }),
            false,
        );
    });
    vm.setProp(hostObj, "sleep", sleepFn);
    sleepFn.dispose();

    vm.setProp(vm.global, "__devshell_host__", hostObj);
    hostObj.dispose();
}

function evaluateUserSource(
    vm: QuickJSContext,
    source: string,
    filename: string,
):
    | { error: QuickJSHandle; unwrapValueProp?: undefined; value?: undefined }
    | { error?: undefined; unwrapValueProp: boolean; value: QuickJSHandle } {
    const trimmed = source.trim();
    if (trimmed.length === 0) {
        const empty = vm.evalCode(
            "Promise.resolve(undefined)",
            filename,
            EvalFlags.JS_EVAL_TYPE_GLOBAL | EvalFlags.JS_EVAL_FLAG_STRICT,
        );
        return empty.error !== undefined
            ? { error: empty.error }
            : { unwrapValueProp: false, value: empty.value };
    }

    const asyncFlags =
        EvalFlags.JS_EVAL_TYPE_GLOBAL |
        EvalFlags.JS_EVAL_FLAG_STRICT |
        JS_EVAL_FLAG_ASYNC;

    // 1. Single object/expression literal (e.g. `{ ok: true }` or `await devshell.instance.list()`)
    const exprCheck = vm.evalCode(
        `(${source})`,
        filename,
        asyncFlags | EvalFlags.JS_EVAL_FLAG_COMPILE_ONLY,
    );
    if (exprCheck.error === undefined) {
        exprCheck.value.dispose();
        const evaluated = vm.evalCode(`(${source})`, filename, asyncFlags);
        return evaluated.error !== undefined
            ? { error: evaluated.error }
            : { unwrapValueProp: true, value: evaluated.value };
    }
    exprCheck.error.dispose();

    // 2. Multi-statement script without top-level `return`: native QuickJS async completion value
    const scriptCheck = vm.evalCode(
        source,
        filename,
        asyncFlags | EvalFlags.JS_EVAL_FLAG_COMPILE_ONLY,
    );
    if (scriptCheck.error === undefined) {
        scriptCheck.value.dispose();
        const evaluated = vm.evalCode(source, filename, asyncFlags);
        return evaluated.error !== undefined
            ? { error: evaluated.error }
            : { unwrapValueProp: true, value: evaluated.value };
    }
    scriptCheck.error.dispose();

    // 3. Script using top-level `return`: wrap in async IIFE
    const wrapped = `(async () => {\n${source}\n})()`;
    const evaluated = vm.evalCode(
        wrapped,
        filename,
        EvalFlags.JS_EVAL_TYPE_GLOBAL | EvalFlags.JS_EVAL_FLAG_STRICT,
    );
    return evaluated.error !== undefined
        ? { error: evaluated.error }
        : { unwrapValueProp: false, value: evaluated.value };
}

function extractCompletionValue(
    vm: QuickJSContext,
    handle: QuickJSHandle,
    unwrapValueProp: boolean,
): unknown {
    if (!unwrapValueProp) return vm.dump(handle);
    const prop = vm.getProp(handle, "value");
    try {
        return vm.dump(prop);
    } finally {
        prop.dispose();
    }
}

function serializeFinalValue(
    raw: unknown,
    maxBytes: number,
): { hasValue: boolean; truncated: boolean; value?: JsonValue } {
    if (raw === undefined) return { hasValue: false, truncated: false };
    let text: string;
    try {
        text = JSON.stringify(raw);
    } catch {
        text = JSON.stringify(inspect(raw, { colors: false, depth: 6 }));
    }
    if (text === undefined) return { hasValue: false, truncated: false };
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength <= maxBytes) {
        return {
            hasValue: true,
            truncated: false,
            value: JSON.parse(text) as JsonValue,
        };
    }
    const preview = text.slice(0, Math.max(256, Math.floor(maxBytes / 2)));
    return {
        hasValue: true,
        truncated: true,
        value: {
            byteLength,
            maxBytes,
            preview,
            truncated: true,
        },
    };
}

function toQuickJsHandle(
    vm: QuickJSContext,
    value: JsonValue | undefined,
): QuickJSHandle {
    if (value === undefined) return vm.undefined;
    if (value === null) return vm.null;
    if (typeof value === "boolean") return value ? vm.true : vm.false;
    if (typeof value === "number") return vm.newNumber(value);
    if (typeof value === "string") return vm.newString(value);
    const json = JSON.stringify(value);
    const parsed = vm.evalCode(
        `JSON.parse(${JSON.stringify(json)})`,
        "<host-value>",
        EvalFlags.JS_EVAL_TYPE_GLOBAL,
    );
    if (parsed.error !== undefined) {
        const msg = formatQuickJsError(vm, parsed.error);
        parsed.error.dispose();
        throw new Error(`Failed to pass host value into QuickJS: ${msg}`);
    }
    return parsed.value;
}

function drainPendingJobs(runtime: QuickJSRuntime): void {
    while (true) {
        const pending = runtime.executePendingJobs();
        if (pending.error !== undefined) {
            pending.error.dispose();
            return;
        }
        if (pending.value === 0) return;
    }
}

function formatQuickJsError(vm: QuickJSContext, handle: QuickJSHandle): string {
    const dumped = vm.dump(handle);
    if (typeof dumped === "object" && dumped !== null) {
        const record = dumped as { message?: unknown; name?: unknown; stack?: unknown };
        const name = typeof record.name === "string" ? record.name : "Error";
        const message = typeof record.message === "string" ? record.message : String(dumped);
        const stack =
            typeof record.stack === "string" && record.stack.trim().length > 0
                ? `\n${record.stack.trim()}`
                : "";
        return `${name}: ${message}${stack}`;
    }
    return String(dumped);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function clampTimeout(
    requested: number | undefined,
    limits: QuickJsEngineLimits,
): number {
    if (requested === undefined) return limits.defaultTimeoutMs;
    if (!Number.isFinite(requested) || requested <= 0) {
        throw createRemoteError({
            code: controlErrorCodes.codeEvalInvalid,
            message: "timeoutMs must be a positive number.",
            retryable: false,
        });
    }
    return Math.min(Math.floor(requested), limits.maxTimeoutMs);
}

function timeoutError(timeoutMs: number): Error {
    return createRemoteError({
        code: controlErrorCodes.codeEvalTimeout,
        message: `Code execution timed out after ${timeoutMs}ms.`,
        retryable: false,
    });
}

function cancelledError(): Error {
    return createRemoteError({
        code: controlErrorCodes.codeEvalCancelled,
        message: "Code execution was cancelled.",
        retryable: false,
    });
}

function evalFailedError(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.codeEvalFailed,
        message,
        retryable: false,
    });
}
