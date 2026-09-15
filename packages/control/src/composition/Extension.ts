import {
    cliModelCommandsExtensionPointDefinition,
    cliNativeCommandsExtensionPointDefinition,
} from "../control/extension/cli/Point.js";
import { ExtensionPointRegistry } from "../control/extension/generation/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodecRegistry } from "../control/extension/generation/sandbox/bridge/PointCodec.js";
import { webApplicationsExtensionPointDefinition } from "../server/web/extension/Point.js";
import { createControlExtensionSandboxPointRegistry } from "./Sandbox.js";

export function createControlExtensionPointRegistry(): ExtensionPointRegistry {
    const points = new ExtensionPointRegistry([
        cliModelCommandsExtensionPointDefinition,
        cliNativeCommandsExtensionPointDefinition,
        webApplicationsExtensionPointDefinition,
    ]);
    assertControlExtensionPointRegistryParity(
        points,
        createControlExtensionSandboxPointRegistry(),
    );
    return points;
}

export function assertControlExtensionPointRegistryParity(
    points: Pick<ExtensionPointRegistry, "ids">,
    sandbox: Pick<ExtensionSandboxPointCodecRegistry, "ids">,
): void {
    const pointIds = points.ids();
    const sandboxIds = sandbox.ids();
    if (
        pointIds.length === sandboxIds.length &&
        pointIds.every((pointId, index) => sandboxIds[index] === pointId)
    ) {
        return;
    }
    throw new TypeError(
        `Control Extension Point registry and sandbox codec registry are out of sync: ` +
            `points=[${pointIds.join(", ")}], sandbox=[${sandboxIds.join(", ")}].`,
    );
}
