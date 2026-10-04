import type {
    ApprovalEventType,
    InstanceName,
    JsonValue,
} from "@portable-devshell/shared";
import type { ApprovalPolicy } from "@portable-devshell/shared/config";

import type { ApprovalApi } from "./Api.js";
import { ApprovalService } from "./Service.js";
import { InstanceApprovalStore } from "./Store.js";

export interface InstanceApprovalPaths {
    auditDatabaseFile: string;
    legacyApprovalsFile: string;
}

export interface InstanceApprovalServiceOptions {
    appendEvent(
        type: ApprovalEventType,
        data: Record<string, JsonValue>,
    ): Promise<unknown>;
    instanceName: InstanceName;
    paths: InstanceApprovalPaths;
    policy?: ApprovalPolicy;
}

export function createInstanceApprovalService(
    options: InstanceApprovalServiceOptions,
): ApprovalApi {
    return new ApprovalService({
        events: {
            append: options.appendEvent,
        },
        instanceName: options.instanceName,
        policy: options.policy,
        store: new InstanceApprovalStore(
            options.paths.auditDatabaseFile,
            options.paths.legacyApprovalsFile,
        ),
    });
}
