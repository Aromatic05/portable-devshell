import {
    asWorkspacePath,
    type ApprovalPolicy,
    type ControlConfig,
    type ControlInstanceAlertsConfig,
    type ControlInstanceConfig
} from "@portable-devshell/shared";

export interface ConfigApplyChange {
    kind: "instance.deleted" | "instance.disabled" | "instance.enabled" | "instance.updated" | "mcp.endpoint.updated" | "web.updated";
    target: string;
}

export interface ConfigApplyResult {
    affectedInstances: string[];
    affectedMcpEndpoints: string[];
    affectedListeners: string[];
    appliedChanges: ConfigApplyChange[];
    reloadRequired: boolean;
    restartControlRequired: boolean;
}

export function buildApplyResult(previous: ControlConfig, next: ControlConfig, appliedChanges: ConfigApplyChange[], hotApplied = false): ConfigApplyResult {
    const affectedInstances = new Set<string>();
    const affectedMcpEndpoints = new Set<string>();
    const affectedListeners = new Set<string>();

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
        affectedMcpEndpoints.add("mcp");
        affectedListeners.add(listenerId(previous.mcp.listenHost, previous.mcp.listenPort));
        affectedListeners.add(listenerId(next.mcp.listenHost, next.mcp.listenPort));
    }
    if (stableStringify(previous.web) !== stableStringify(next.web)) {
        affectedListeners.add(listenerId(previous.web.listenHost, previous.web.listenPort));
        affectedListeners.add(listenerId(next.web.listenHost, next.web.listenPort));
    }

    return {
        affectedInstances: [...affectedInstances].sort((left, right) => left.localeCompare(right)),
        affectedMcpEndpoints: [...affectedMcpEndpoints].sort((left, right) => left.localeCompare(right)),
        affectedListeners: [...affectedListeners].sort((left, right) => left.localeCompare(right)),
        appliedChanges,
        reloadRequired: affectedInstances.size > 0,
        restartControlRequired: !hotApplied && (
            stableStringify(previous.mcp) !== stableStringify(next.mcp) ||
            stableStringify(previous.web) !== stableStringify(next.web)
        )
    };
}

function listenerId(host: string, port: number): string {
    return `${host}:${port}`;
}

export function toWorkerReconfigureInput(instance: ControlInstanceConfig): {
    alerts?: ControlInstanceAlertsConfig;
    approvalPolicy?: ApprovalPolicy;
    defaultWorkspace?: ReturnType<typeof asWorkspacePath>;
    effectiveSecurityMode: "disabled" | "workspace";
    env?: NodeJS.ProcessEnv;
} {
    const effectiveSecurityMode = instance.security.mode;

    return {
        alerts: instance.alerts === undefined ? undefined : {
            ...instance.alerts,
            scripts: instance.alerts.scripts?.map((script) => ({ ...script, command: [...script.command] })),
        },
        approvalPolicy: instance.approvalPolicy,
        defaultWorkspace: asWorkspacePath(instance.workspace),
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
