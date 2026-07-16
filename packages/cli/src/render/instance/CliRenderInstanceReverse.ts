import type { ReverseDeviceCodeResult } from "@portable-devshell/shared";

export function renderReverseDeviceCode(result: ReverseDeviceCodeResult): string {
    return [
        `instance: ${result.instance}`,
        `device code: ${result.deviceCode}`,
        `expires: ${result.expiresAt}`,
        `enroll: devshell-worker enroll --controller ${result.controllerUrl} --device-code ${result.deviceCode}`,
        ""
    ].join("\n");
}

export function renderReverseTokenRotation(result: { deviceToken: string; instance: string }): string {
    return [
        `instance: ${result.instance}`,
        "device token rotated",
        `new device token: ${result.deviceToken}`,
        "Update the remote worker credential before reconnecting.",
        ""
    ].join("\n");
}

export function renderReverseTokenRevocation(result: { instance: string; revoked: true }): string {
    return `instance: ${result.instance}\ndevice token revoked\n`;
}
