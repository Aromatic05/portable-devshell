import type { ContextRegistryPort, JsonValue } from "@portable-devshell/shared";

import type { McpWorkspaceActionGateway } from "../instance/Gateway.js";
import type { WorkspaceReentryDirective } from "./model/Contract.js";
import { readWorkspaceSnapshot } from "./Projection.js";

export async function readWorkspaceContextInstances(
    registry: ContextRegistryPort,
    instance: string,
    ctxId: string,
): Promise<string[]> {
    const record = await registry.validateForInstance(ctxId, instance);
    return [...new Set([instance, ...record.environments.map((e) => e.instance)])];
}

export async function readContextWorkspaceSnapshot(
    registry: ContextRegistryPort,
    gateway: McpWorkspaceActionGateway,
    instance: string,
    ctxId: string,
    directives?: WorkspaceReentryDirective[],
): Promise<JsonValue> {
    const record = await registry.validateForInstance(ctxId, instance);
    const { reentry } = registry;
    const state = await reentry.readAutomaticReentry(ctxId, instance);
    return await readWorkspaceSnapshot(gateway, instance, ctxId, {
        instances: record.environments.map((e) => e.instance),
        reentry: state as unknown as JsonValue,
        directives,
    });
}
