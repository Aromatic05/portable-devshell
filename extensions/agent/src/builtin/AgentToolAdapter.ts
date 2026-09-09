import type { ExtensionContext, ExtensionWorkerSession } from "@portable-devshell/extension";

import type { AgentToolSession } from "./provider/AgentToolSession.js";
import { parseAgentWorkerTarget, type AgentWorkerTarget } from "./worker/AgentWorkerTarget.js";

export async function openAgentToolSession(
    context: ExtensionContext,
    target: AgentWorkerTarget
): Promise<AgentToolSession> {
    const workers = context.capabilities.workers;
    if (workers === undefined) throw new Error("Agent Extension requires the workers capability.");
    const worker = await workers.openSession({
        instance: target.instance,
        workspace: target.workspace
    });
    return adaptWorkerSession(worker);
}

function adaptWorkerSession(worker: ExtensionWorkerSession): AgentToolSession {
    return {
        closed: worker.closed,
        target: parseAgentWorkerTarget(`${worker.instance}:${worker.workspace}`),
        tools: worker.listTools().map((tool) => ({
            description: tool.description,
            inputSchema: tool.inputSchema,
            name: tool.name
        })),
        callTool: async (toolName, input, operationId, signal, onProgress) => await worker.callTool(
            toolName,
            input,
            { onProgress, operationId, signal }
        ),
        close: async () => await worker.close()
    };
}
