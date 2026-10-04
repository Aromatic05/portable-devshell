import {
    mcpTools,
    type McpToolRegistration,
} from "@portable-devshell/mcp/tool";
import type { ToolDefinition } from "@portable-devshell/shared";

export class WorkerMcpToolRegistration {
    readonly #registration: McpToolRegistration;

    constructor(instance: string) {
        this.#registration = mcpTools.register(instance, []);
    }

    replace(definitions: readonly ToolDefinition[]): void {
        this.#registration.replace(definitions);
    }

    dispose(): void {
        this.#registration.dispose();
    }
}
