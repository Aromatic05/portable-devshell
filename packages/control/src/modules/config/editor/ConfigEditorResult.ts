import { asWorkspacePath, type ApprovalPolicy } from "@portable-devshell/shared";

import type { ControlConfig, ControlInstanceConfig } from "../config/codec/ConfigTomlCodec.js";
import { resolveSecurityMode } from "./ConfigEditorValue.js";

export interface ConfigApplyChange {
    kind: "instance.deleted" | "instance.disabled" | "instance.enabled" | "instance.updated" | "mcp.updated";
    target: string;
}

export interface ConfigApplyResult {
    affectedInstances: string[];
    affectedMcpEndpoints: string[];
    appliedChanges: ConfigApplyChange[];
    reloadRequired: boolean;
    restartControlRequired: boolean;
}

export const emptyApplyResult = (): ConfigApplyResult => ({
    affectedInstances: [],
    affectedMcpEndpoints: [],
    appliedChanges: [],
    reloadRequired: false,
    restartControlRequired: false
});

export function buildApplyResult(previous: ControlConfig, next: ControlConfig, appliedChanges: ConfigApplyChange[]): ConfigApplyResult {
    const affectedInstances = new Set<string>();
    const affectedMcpEndpoints = new Set<string>();
    let restartControlRequired = false;

    const previousInstances = new Map(previous.instances.map((instance) => [instance.name, instance] as const));
    const nextInstances = new Map(next.instances.map((instance) => [instance.name, instance] as const));
    const instanceNames = new Set([...previousInstances.keys(), ...nextInstances.keys()]);

    for (const instanceName of instanceNames) {
        const previousInstance = previousInstances.get(instanceName);
        const nextInstance = nextInstances.get(instanceName);

        if (stableStringify(previousInstance) === stableStringify(nextInstance)) {
            continue;
        }

        affectedInstances.add(instanceName);
        if (hasMcpEndpointChange(previousInstance, nextInstance)) {
            affectedMcpEndpoints.add(nextInstance?.mcp.path ?? previousInstance?.mcp.path ?? `/${instanceName}/mcp`);
        }
    }

    if (stableStringify(previous.mcp) !== stableStringify(next.mcp)) {
        restartControlRequired = true;
        affectedMcpEndpoints.add("mcp");
    }

    return {
        affectedInstances: [...affectedInstances].sort((left, right) => left.localeCompare(right)),
        affectedMcpEndpoints: [...affectedMcpEndpoints].sort((left, right) => left.localeCompare(right)),
        appliedChanges,
        reloadRequired: affectedInstances.size > 0,
        restartControlRequired
    };
}

export function mergeApplyResults(previous: ConfigApplyResult, next: ConfigApplyResult): ConfigApplyResult {
    return {
        affectedInstances: [...new Set([...previous.affectedInstances, ...next.affectedInstances])].sort((left, right) =>
            left.localeCompare(right)
        ),
        affectedMcpEndpoints: [...new Set([...previous.affectedMcpEndpoints, ...next.affectedMcpEndpoints])].sort((left, right) =>
            left.localeCompare(right)
        ),
        appliedChanges: [...previous.appliedChanges, ...next.appliedChanges],
        reloadRequired: previous.reloadRequired || next.reloadRequired,
        restartControlRequired: previous.restartControlRequired || next.restartControlRequired
    };
}

export function toWorkerReconfigureInput(instance: ControlInstanceConfig): {
    approvalPolicy?: ApprovalPolicy;
    defaultWorkspace?: ReturnType<typeof asWorkspacePath>;
    effectiveSecurityMode: "disabled" | "workspace";
    env?: NodeJS.ProcessEnv;
} {
    const effectiveSecurityMode = resolveSecurityMode(instance.security?.mode);

    return {
        approvalPolicy: instance.approvalPolicy,
        defaultWorkspace: instance.workspace === undefined ? undefined : asWorkspacePath(instance.workspace),
        effectiveSecurityMode,
        env: {
            ...instance.env,
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
            DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode
        }
    };
}

export function requiresWorkerRebuild(previous: ControlInstanceConfig, next: ControlInstanceConfig): boolean {
    return [
        previous.provider !== next.provider,
        stableStringify(previous.ssh) !== stableStringify(next.ssh),
        stableStringify(previous.container) !== stableStringify(next.container),
        previous.dockerBinary !== next.dockerBinary,
        previous.podmanBinary !== next.podmanBinary,
        stableStringify(previous.logs) !== stableStringify(next.logs),
        stableStringify(previous.tools) !== stableStringify(next.tools)
    ].some(Boolean);
}

function hasMcpEndpointChange(
    previousInstance: ControlInstanceConfig | undefined,
    nextInstance: ControlInstanceConfig | undefined
): boolean {
    return stableStringify(previousInstance?.mcp) !== stableStringify(nextInstance?.mcp);
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value);
}
