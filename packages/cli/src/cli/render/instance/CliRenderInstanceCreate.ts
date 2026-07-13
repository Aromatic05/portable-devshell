import type { InstanceCreateResult, ReverseDeviceCodeResult } from "@portable-devshell/shared";

interface RenderableInstanceCreateResult extends InstanceCreateResult {
    reverseDeviceCode?: ReverseDeviceCodeResult;
}

export function renderInstanceCreateResult(result: RenderableInstanceCreateResult): string {
    const lines = [`instance created: ${result.name}`, `enabled: ${result.enabled}`];

    if (result.mcpPath !== undefined) {
        lines.push(`mcp path: ${result.mcpPath}`);
    }

    if (result.snapshot !== undefined) {
        lines.push(`status: ${result.snapshot.status}`);
    }

    if (result.reverseDeviceCode !== undefined) {
        lines.push(`device code: ${result.reverseDeviceCode.deviceCode}`);
        lines.push(`device code expires: ${result.reverseDeviceCode.expiresAt}`);
        lines.push(
            `enroll: devshell-worker enroll --controller ${result.reverseDeviceCode.controllerUrl} --device-code ${result.reverseDeviceCode.deviceCode}`
        );
    }

    return `${lines.join("\n")}\n`;
}
