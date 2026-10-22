import type { ToolCallRewriteBinding } from "@portable-devshell/extension/toolcall";
import type { MailingService } from "./Service.js";

/** Observe completed file edits; file changes by shells are covered by periodic reconciliation. */
export function createMailingHook(
    mailing: Pick<MailingService, "scan">,
    onError: (error: unknown) => void,
): ToolCallRewriteBinding {
    return (input) => {
        if (input.direction !== "outbound" || input.value.kind !== "result" ||
            input.value.toolName !== "file_edit" ||
            input.value.context.source === "extension" ||
            input.value.context.workspace === undefined)
            return input.value;
        const result = input.value.payload;
        if (result === null || typeof result !== "object" || Array.isArray(result))
            return input.value;
        const operations = result.operations;
        if (!Array.isArray(operations)) return input.value;
        const changed = operations.some((entry) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
            const operation = entry as Record<string, unknown>;
            return operation.status === "applied" && typeof operation.path === "string" &&
                /^\.?\/?(?:.*\/)?var\/agent-work\/[^/]+\/chat\.md$/u.test(operation.path);
        });
        if (changed) {
            void mailing.scan({
                instance: input.value.context.instance,
                workspace: input.value.context.workspace,
            }).catch(onError);
        }
        return input.value;
    };
}

/** The initial environ_info only advises the model. Its next tool call
 * automatically binds an unclaimed Context, without blocking execution on
 * Worker or Extension availability errors.
 */
export function createMemoryAutoHook(
    mailing: Pick<MailingService, "ensureBound">,
    onError: (error: unknown) => void,
): ToolCallRewriteBinding {
    return async (input) => {
        const call = input.value;
        if (input.direction !== "inbound" || call.kind !== "call" ||
            call.context.source !== "mcp" || call.toolName === "environ_info" ||
            call.context.ctxId === undefined || call.context.workspace === undefined)
            return call;
        // Do not preempt a deliberate memory init/inherit command launched
        // through the ordinary bash tool; that would leave an orphan fallback.
        const payload = call.payload;
        if (call.toolName === "bash_run" && payload !== null &&
            typeof payload === "object" && !Array.isArray(payload) &&
            typeof payload.command === "string" &&
            /^\s*devshell\s+memory\s+(?:init|inherit)\s+[^\s]+(?:\s*)$/u.test(payload.command))
            return call;
        await mailing.ensureBound({
            ctxId: call.context.ctxId,
            instance: call.context.instance,
            workspace: call.context.workspace,
        }).catch(onError);
        return call;
    };
}
