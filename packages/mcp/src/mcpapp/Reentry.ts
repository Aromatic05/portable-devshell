import type { ContextTransport, JsonValue } from "@portable-devshell/shared";
import type { McpEndpointCallContext } from "../protocol/call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "../protocol/call/Boundary.js";
import type { McpEndpointDispatch } from "../protocol/Api.js";
import { readMcpContextInput } from "../protocol/context/Selector.js";
import type { McpAppActionStore } from "./ActionStore.js";
import type { createMcpAppViewModel } from "./ViewModel.js";

/** MCP binds a durable delivery receipt, but all Goal mutations enter Instance ToolCall. */
export async function deliverMcpAppReentry(
    ports: {
        actions: McpAppActionStore;
        context: Pick<ContextTransport, "resolve">;
        dispatch: Pick<McpEndpointDispatch, 'callTool'>;
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
        (directiveId !== undefined && (typeof directiveId !== "string" || !directiveId || directiveId.length > 128)) ||
        (action === "report" && !["accepted", "rejected", "uncertain"].includes(String(outcome))))
        throw new Error("Invalid MCP App recovery request.");
    const context = await ports.context.resolve({
        ctxId, instance: ports.instance, principal: request.principal, touch: false,
    });
    const environment = context.environments.find((entry) => entry.instance === ports.instance);
    if (context.status !== "active" || environment === undefined)
        throw new Error("MCP App recovery Context is unavailable.");

    const payload = input;
    const owner = claimId;
    const workspace = environment.workspace;
    return typeof directiveId === "string"
        ? await ports.actions.withDelivery(directiveId, advance)
        : await advance();

    async function dispatch(payload: JsonValue, cleanup = false) {
        const result = await ports.dispatch.callTool("mcpapp_reentry", payload, request, cleanup ? undefined : signal);
        if (result instanceof McpNativeToolResult && result.isError)
            throw new Error("Instance recovery request failed.");
        const value = result instanceof McpNativeToolResult ? result.structuredContent : result;
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new Error("Invalid Instance recovery result.");
        return { result, value };
    }

    async function advance(): Promise<McpEndpointResult> {
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
                    (intent !== "goal-resume" && intent !== "goal-retry" && intent !== "task-resume"))
                    return { claimed: false };
                if (await ports.actions.beginDelivery(directiveId, owner) === undefined)
                    return { claimed: false };
            }
            try {
                const { result, value } = await dispatch(input);
                if (value.claimed !== true) {
                    if (typeof directiveId === "string")
                        await ports.actions.restoreDelivery(directiveId, owner);
                    return result;
                }
                const snapshot = await ports.view.snapshot(ports.instance, ctxId, workspace);
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
            } catch (error) {
                // A failed reply may follow a committed Instance claim. Confirm
                // release before reoffering its receipt, even after cancellation.
                try {
                    const { value } = await dispatch({ ...payload, action: "release" }, true);
                    if (value.released === true && typeof directiveId === "string")
                        await ports.actions.restoreDelivery(directiveId, owner);
                } catch { /* Fail closed when release status is uncertain. */ }
                throw error;
            }
        }

        if (receipt !== undefined) {
            const owned = receipt.claimId === claimId;
            if (action === "validate" && (!owned || receipt.status !== "attempting"))
                return { valid: false };
            if (action === "attempt") {
                if (!owned) return { attempted: false };
                if (receipt.status === "attempted") return { attempted: false, duplicate: true };
                if (receipt.status !== "attempting") return { attempted: false };
            }
            if (action === "release" && (!owned || receipt.status !== "attempting"))
                return { released: false };
            if (action === "report" && await ports.actions.beginReport(
                directiveId as string, owner, outcome as "accepted" | "rejected" | "uncertain",
            ) === undefined) return { reported: false };
        }

        const { result, value } = await dispatch(input);
        if (typeof directiveId === "string") {
            if (action === "validate" && value.valid === false)
                await ports.actions.restoreDelivery(directiveId, owner);
            if (action === "release" && value.released === true &&
                !await ports.actions.restoreDelivery(directiveId, owner)) return { released: false };
            if (action === "attempt" && (value.attempted === true || value.duplicate === true) &&
                await ports.actions.markAttempted(directiveId, owner) === undefined) return { attempted: false };
            if (action === "report" && (value.reported === true || (outcome === "uncertain" && value.uncertain === true)) &&
                await ports.actions.settle(directiveId, owner, outcome as "accepted" | "rejected" | "uncertain") === undefined)
                return { reported: false };
        }
        return result;
    }
}
