import type { ContextLifecycleCleanupPort, ContextRecordSourcePort, } from "../Api.js";
import { contextErrorCodes, createRemoteError, type ContextResolveInput, type ContextRecord, type EnvironmentTransport, type ProcessTransport } from "@portable-devshell/shared";
import type { ContextEnvironmentPort } from "../Api.js";

export class ContextService {
    readonly registry: ContextRecordSourcePort;
    readonly environment: ContextEnvironmentPort;
    readonly cleanup: ContextLifecycleCleanupPort;
    readonly #environment: (instance: string) => EnvironmentTransport;
    readonly #leaseInstance: (instance: string) => { release(): void };
    readonly #process: (instance: string) => ProcessTransport;

    constructor(options: {
        registry: ContextRecordSourcePort;
        environment: ContextEnvironmentPort;
        cleanup: ContextLifecycleCleanupPort;
        environmentTransport(instance: string): EnvironmentTransport;
        leaseInstance(instance: string): { release(): void };
        process(instance: string): ProcessTransport;
    }) {
        this.registry = options.registry;
        this.environment = options.environment;
        this.cleanup = options.cleanup;
        this.#environment = options.environmentTransport;
        this.#leaseInstance = options.leaseInstance;
        this.#process = options.process;
    }

    async initialize(): Promise<void> {
        await this.registry.initialize();
    }

    async reconcile(): Promise<void> {
        await this.cleanup.reconcile();
    }

    async reconcileInstance(instance: string): Promise<void> {
        await this.cleanup.reconcileInstance(instance);
    }

    async resolve(input: ContextResolveInput): Promise<ContextRecord> {
        const principal = input.principal;
        let ctxId = input.ctxId;
        if (ctxId === undefined) {
            for (const binding of input.externalBindings ?? []) {
                const record = await this.registry.lookupExternal(binding, {
                    principal,
                });
                if (record === undefined) continue;
                if (ctxId !== undefined && ctxId !== record.ctxId)
                    throw createRemoteError({
                        code: contextErrorCodes.invalid,
                        message: "External Context bindings disagree on ctxId.",
                        retryable: false,
                    });
                ctxId = record.ctxId;
            }
        }
        if (ctxId === undefined)
            throw createRemoteError({
                code: contextErrorCodes.invalid,
                message:
                    "No Context is bound to this request. Call environ_info with workspace.",
                retryable: false,
            });

        return await this.cleanup.withContext(ctxId, async () => {
            const previous = await this.registry.lookup(ctxId, { principal });
            if (previous.status === "disabled")
                return await this.registry.validate(ctxId, { principal });
            if (input.instance !== undefined) {
                await this.registry.assertInstanceAvailable(ctxId, input.instance);
                const environment = previous.environments.find(
                    (attachment) => attachment.instance === input.instance,
                );
                if (input.touch !== false && (
                    previous.status === "expired" ||
                    (environment?.workspace !== undefined && environment.temporaryDirectory === undefined)
                )) {
                    try {
                        await this.environment.recover(ctxId, input.instance);
                    } catch (error) {
                        await this.registry.park(ctxId);
                        throw error;
                    }
                }
            }
            return input.touch === false
                ? previous
                : await this.registry.renewForPrincipal(ctxId, { principal });
        });
    }

    async disable(ctxId: string): Promise<ContextRecord> {
        const record = await this.registry.disable(ctxId);
        await this.cleanup.terminate(record);
        return record;
    }

    async renew(ctxId: string): Promise<ContextRecord> {
        const record = await this.registry.renew(ctxId);
        for (const environment of record.environments) {
            if (environment.workspace === undefined) continue;
            let lease: { release(): void };
            try {
                lease = this.#leaseInstance(environment.instance);
            } catch {
                continue;
            }
            try {
                if (
                    (await this.#process(environment.instance).snapshot()).snapshot
                        .ready === true
                )
                    await this.#environment(environment.instance).touchAlerts(
                        environment.workspace,
                    );
            } finally {
                lease.release();
            }
        }
        return record;
    }

    async detachInstance(instance: string): Promise<ContextRecord[]> {
        return await this.registry.detachInstance(instance);
    }
}
