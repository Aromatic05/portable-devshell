import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { projectHistoricalAgentToolResult } from "../../../builtin/provider/AgentToolProjection.js";

export function compactDevshellPiContext(
    event: ContextEvent,
): { messages?: ContextEvent["messages"] } | void {
    const cutoff = findLastAssistantMessage(event.messages);
    if (cutoff <= 0) return;

    let changed = false;
    const messages = event.messages.map((message, index) => {
        if (index >= cutoff || message.role !== "toolResult") return message;
        const historical = projectHistoricalAgentToolResult(
            message.toolName,
            message.details,
        );
        if (historical === undefined) return message;
        changed = true;
        return {
            ...message,
            content: [{ text: historical, type: "text" as const }],
        };
    });

    return changed ? { messages } : undefined;
}

function findLastAssistantMessage(messages: ContextEvent["messages"]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "assistant") return index;
    }
    return -1;
}
