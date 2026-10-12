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
