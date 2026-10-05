import type { ContextTransport, JsonValue } from "@portable-devshell/shared";

import type { McpAppActionGateway } from "../instance/Gateway.js";
import type { McpAppReentryDirective } from "./model/Contract.js";
import { readMcpAppSnapshot } from "./Projection.js";

export async function readMcpAppContextInstances(
    contexts: Pick<ContextTransport, "reentry" | "validateForInstance">,
    instance: string,
    ctxId: string,
): Promise<string[]> {
    const record = await contexts.validateForInstance(ctxId, instance);
    return [...new Set([instance, ...record.environments.map((e) => e.instance)])];
}

export async function readContextWorkspaceSnapshot(
    contexts: Pick<ContextTransport, "reentry" | "validateForInstance">,
    gateway: McpAppActionGateway,
    instance: string,
    ctxId: string,
    directives?: McpAppReentryDirective[],
): Promise<JsonValue> {
    const record = await contexts.validateForInstance(ctxId, instance);
    const { reentry } = contexts;
    const state = await reentry.readAutomaticReentry(ctxId, instance);
    return await readMcpAppSnapshot(gateway, instance, ctxId, {
        instances: record.environments.map((e) => e.instance),
        reentry: state as unknown as JsonValue,
        directives,
    });
}
