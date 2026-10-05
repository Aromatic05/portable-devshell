import type {
    ContextRecord,
    ContextResolveInput,
} from "@portable-devshell/shared";

import type { ContextEnvironmentPort } from "./Port.js";
import type { ContextLifecycleCleanupPort } from "./service/Cleanup.js";
import type { ContextRecordSourcePort } from "./service/index.js";

export interface ContextApi {
    readonly cleanup: ContextLifecycleCleanupPort;
    readonly environment: ContextEnvironmentPort;
    readonly registry: ContextRecordSourcePort;
    disable(ctxId: string): Promise<ContextRecord>;
    detachInstance(instance: string): Promise<ContextRecord[]>;
    reconcileInstance(instance: string): Promise<void>;
    renew(ctxId: string): Promise<ContextRecord>;
    resolve(input: ContextResolveInput): Promise<ContextRecord>;
}
