import {
    createRemoteError,
    contextErrorCodes,
    runtimeErrorCodes,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextEnvironmentCleanup,
    type McpContextExternalBinding,
} from "@portable-devshell/shared";
import type {
    ContextCleanupLedgerPort,
    ContextRecordPort,
} from "@portable-devshell/shared";
import type {
    ContextEnvironmentPort,
    PreparedEnvironmentFacts,
} from "../Port.js";
import { ContextCleanupService } from "./Cleanup.js";

export class ContextEnvironmentService implements ContextEnvironmentPort {
    readonly #registry: ContextRecordPort & ContextCleanupLedgerPort;
    readonly #cleanup: ContextCleanupService;
    readonly #transactions = new Map<string, Promise<void>>();

    constructor(options: {
        contextRegistry: ContextRecordPort & ContextCleanupLedgerPort;
        cleanup: ContextCleanupService;
    }) {
        this.#registry = options.contextRegistry;
        this.#cleanup = options.cleanup;
    }

    async maskRemote(
        ctxId: string,
        handle: string,
    ): Promise<{ instance: string; masked: true }> {
        return await this.#run(ctxId, async () => {
            const masked = await this.#registry.maskRemoteInstance(
                ctxId,
                handle,
            );
            await this.#cleanup.reconcile(ctxId);
            return { instance: masked.instance, masked: true };
        });
    }

    async rollbackUndisclosed(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<void> {
        if (workspace === undefined) {
            const pending = await this.#registry.listEnvironmentCleanup(ctxId);
            if (pending.length === 0) {
                await this.#registry.discard(ctxId);
                return;
            }
            await this.#registry.disable(ctxId);
            await this.#cleanup.reconcile(ctxId);
            if (
                (await this.#registry.listEnvironmentCleanup(ctxId)).length ===
                0
            ) {
                await this.#registry.discard(ctxId);
            }
            return;
        }
        await this.#registry.disable(ctxId);
        await this.#registry.recordEnvironmentCleanup(ctxId, {
            instance,
            kind: "alerts",
            workspace,
        });
        await this.#cleanup.reconcile(ctxId);
        if ((await this.#registry.listEnvironmentCleanup(ctxId)).length === 0) {
            await this.#registry.discard(ctxId);
        }
    }

    async #environment(ctxId: string, instance: string) {
        return await this.#registry.resolveEnvironment(ctxId, instance);
    }

    async #restoreEnvironment(
        ctxId: string,
        instance: string,
        previous?: McpContextEnvironment,
    ): Promise<void> {
        if (previous === undefined) {
            await this.#registry.detachEnvironment(ctxId, instance);
            return;
        }
        await this.#registry.attachEnvironment(ctxId, previous);
    }

    async #releasePreparedWorkspace(
        ctxId: string,
        instance: string,
        workspace: string,
    ): Promise<void> {
        await this.#registry.recordEnvironmentCleanup(ctxId, {
            instance,
            kind: "alerts",
            workspace,
        });
    }

    #run<T>(ctxId: string, operation: () => Promise<T>): Promise<T> {
        const key = ctxId;
        const previous = this.#transactions.get(key) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const completion = run.then(
            () => undefined,
            () => undefined,
        );
        this.#transactions.set(key, completion);
        void completion.then(() => {
            if (this.#transactions.get(key) === completion)
                this.#transactions.delete(key);
        });
        return run;
    }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRecoverableTemporaryError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: unknown }).code ===
            "workspace.temporaryUnavailable" ||
            (error as { code?: unknown }).code === "workspace.temporaryInvalid")
    );
}
async function waitAbortable<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (signal === undefined) return await operation;
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () =>
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Remote environment operation was cancelled."),
            );
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
}
