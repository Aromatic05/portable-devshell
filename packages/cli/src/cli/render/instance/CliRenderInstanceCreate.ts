import type { InstanceCreateResult } from "@portable-devshell/shared";

export function renderInstanceCreateResult(result: InstanceCreateResult): string {
    const lines = [`instance created: ${result.name}`, `enabled: ${result.enabled}`];

    if (result.mcpPath !== undefined) {
        lines.push(`mcp path: ${result.mcpPath}`);
    }

    if (result.snapshot !== undefined) {
        lines.push(`status: ${result.snapshot.status}`);
    }

    return `${lines.join("\n")}\n`;
}
