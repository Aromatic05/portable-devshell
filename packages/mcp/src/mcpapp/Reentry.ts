import type { ContextTransport, JsonValue } from "@portable-devshell/shared";
import type { McpEndpointCallContext } from "../endpoint/call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "../endpoint/call/Boundary.js";
import type { McpEndpointDispatch } from "../endpoint/dispatch/Dispatch.js";
import { readMcpContextInput } from "../context/Selector.js";
import type { McpAppActionStore } from "./ActionStore.js";
import type { createMcpAppViewModel } from "./ViewModel.js";

/** MCP binds a durable delivery receipt, but all Goal mutations enter Instance ToolCall. */
export async function deliverMcpAppReentry(
    ports: {
        actions: McpAppActionStore;
        context: Pick<ContextTransport, "resolve">;
        dispatch: McpEndpointDispatch;
        instance: string;
        view: ReturnType<typeof createMcpAppViewModel>;
    },
    input: JsonValue,
    request: McpEndpointCallContext,
    signal?: AbortSignal,
): Promise<McpEndpointResult> {
    const { ctxId } = readMcpContextInput(input);
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw new Error("Invalid MCP App recovery request.");
    const { action, claimId, intent, sourceId, directiveId, outcome } = input;
    if (!["claim", "validate", "attempt", "report", "release"].includes(String(action)) ||
        typeof claimId !== "string" || !claimId || claimId.length > 128 ||
        (directiveId !== undefined && (typeof directiveId !== "string" || !directiveId || directiveId.length > 128)))
        throw new Error("Invalid MCP App recovery request.");
    const context = await ports.context.resolve({
        ctxId, instance: ports.instance, principal: request.principal, touch: false,
    });
    const environment = context.environments.find((entry) => entry.instance === ports.instance);
    if (context.status !== "active" || environment === undefined)
        throw new Error("MCP App recovery Context is unavailable.");

    const receipt = typeof directiveId === "string"
        ? await ports.actions.get(directiveId) : undefined;
    if (directiveId !== undefined && (receipt?.ctxId !== ctxId || receipt.instance !== ports.instance ||
        receipt.effect?.id !== directiveId || receipt.effect.kind !== "reentry" ||
        receipt.effect.intent !== intent || receipt.effect.sourceId !== sourceId))
        throw new Error("Recovery directive is not owned by the current Context.");
    if (action === "claim") {
        if (intent === "automatic") {
            if (directiveId !== undefined || typeof sourceId !== "string")
                throw new Error("Invalid automatic recovery intent.");
        } else {
            if (typeof directiveId !== "string" || receipt?.status !== "applied" ||
                receipt.effect?.intent !== intent || receipt.effect.sourceId !== sourceId ||
                (intent !== "goal-resume" && intent !== "goal-retry" && intent !== "task-resume"))
                return { claimed: false };
            const reserved = await ports.actions.beginDelivery(directiveId);
            if (reserved === undefined) return { claimed: false };
        }
    } else if (receipt !== undefined &&
        !["attempting", "attempted", "reporting"].includes(receipt.status)) {
        return { valid: false, attempted: false };
    }
    if (action === "attempt" && receipt?.status === "attempted")
        return { attempted: false, duplicate: true };

    let result: McpEndpointResult;
    try {
        result = await ports.dispatch.callTool("mcpapp_reentry", input, request, signal);
        if (result instanceof McpNativeToolResult && result.isError)
            throw new Error("Instance recovery request failed.");
    } catch (error) {
        if (action === "claim" && typeof directiveId === "string")
            await ports.actions.restoreDelivery(directiveId).catch(() => undefined);
        throw error;
    }
    const value = result instanceof McpNativeToolResult ? result.structuredContent : result;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Invalid Instance recovery result.");

    if (action === "claim") {
        if (value.claimed !== true) {
            if (typeof directiveId === "string")
                await ports.actions.restoreDelivery(directiveId);
            return result;
        }
        const snapshot = await ports.view.snapshot(ports.instance, ctxId, environment.workspace);
        const title = snapshot.presentation.work.find((item) => item.id === sourceId)?.title ?? "the current work item";
        return {
            ...value,
            delivery: {
                message: intent === "automatic"
                    ? `The existing workspace Goal is due for continuation: ${title}. Review current state and continue its pending steps.`
                    : intent === "task-resume"
                        ? `The user resumed the workspace Task: ${title}. Review the current Todo and background work before continuing.`
                        : `The user resumed the workspace Goal: ${title}. Review the latest state and continue its pending steps.`,
                modelContext: snapshot.modelContext as unknown as JsonValue,
            },
        };
    }

    if (typeof directiveId === "string") {
        if (action === "validate" && value.valid !== true)
            await ports.actions.restoreDelivery(directiveId);
        if (action === "attempt" && value.attempted === true)
            await ports.actions.markAttempted(directiveId);
        if (action === "report" && typeof outcome === "string" &&
            ["accepted", "rejected", "uncertain"].includes(outcome)) {
            const status = outcome as "accepted" | "rejected" | "uncertain";
            await ports.actions.beginReport(directiveId, status);
            await ports.actions.settle(directiveId, status);
        }
        if (action === "release")
            await ports.actions.restoreDelivery(directiveId);
    }
    return result;
}
