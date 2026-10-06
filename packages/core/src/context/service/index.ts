import type {
    ContextLifecycleCleanupPort,
    ContextRecordSourcePort,
} from "../Api.js";
import { contextErrorCodes, createRemoteError, type ContextResolveInput, type ContextRecord } from "@portable-devshell/shared";
import type { ContextEnvironmentPort } from "../Api.js";
import type { InstanceLease, InstanceRegistry } from "../../instance/Api.js";

export class ContextService {
    readonly registry: ContextRecordSourcePort;
    readonly environment: ContextEnvironmentPort;
    readonly cleanup: ContextLifecycleCleanupPort;
    readonly #instances: InstanceRegistry;

    constructor(options: {
        registry: ContextRecordSourcePort;
        environment: ContextEnvironmentPort;
        cleanup: ContextLifecycleCleanupPort;
        instances: InstanceRegistry;
    }) {
        this.registry = options.registry;
        this.environment = options.environment;
        this.cleanup = options.cleanup;
        this.#instances = options.instances;
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

        let record = await this.registry.lookup(ctxId, { principal });
        if (record.status === "disabled")
            return await this.registry.validate(ctxId, { principal });
        if (record.status === "expired") {
            if (input.renewExpired === true)
                record = await this.registry.renewForPrincipal(ctxId, {
                    principal,
                });
            else if (input.acceptExpired !== true)
                return await this.registry.validate(ctxId, { principal });
        } else if (input.touch === true) {
            record = await this.registry.validateAndTouch(ctxId, { principal });
        } else {
            record = await this.registry.validate(ctxId, { principal });
        }
        if (input.instance !== undefined)
            await this.registry.assertInstanceAvailable(
                record.ctxId,
                input.instance,
            );
        return record;
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
            const instance = this.#instances.get(environment.instance);
            if (instance === undefined) continue;
            let lease: InstanceLease;
            try {
                lease = instance.acquireLease();
            } catch {
                continue;
            }
            try {
                const worker = lease.instance.worker;
                if (worker.snapshot().ready === true)
                    await worker.touchAlerts(environment.workspace);
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
