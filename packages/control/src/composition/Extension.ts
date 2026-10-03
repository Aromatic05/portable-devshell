import {
    cliModelCommandsExtensionPointDefinition,
    cliNativeCommandsExtensionPointDefinition,
} from "../extension/cli/Point.js";
import { controlRoutesExtensionPointDefinition } from "../extension/Route.js";
import { mcpToolsExtensionPointDefinition } from "./mcp/extension/Point.js";
import { tuiPagesExtensionPointDefinition } from "../extension/tui/Point.js";
import {
    toolCallReviewExtensionPointDefinition,
    toolCallRewriteExtensionPointDefinition,
} from "../extension/toolcall/Point.js";
import { ExtensionPointRegistry } from "../extension/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodecRegistry } from "../extension/sandbox/bridge/PointCodec.js";
import {
    webApplicationsExtensionPointDefinition,
    webPagesExtensionPointDefinition,
} from "../server/web/extension/Point.js";
import { createControlExtensionSandboxPointRegistry } from "./Sandbox.js";

export function createControlExtensionPointRegistry(): ExtensionPointRegistry {
    const points = new ExtensionPointRegistry([
        cliModelCommandsExtensionPointDefinition,
        cliNativeCommandsExtensionPointDefinition,
        controlRoutesExtensionPointDefinition,
        mcpToolsExtensionPointDefinition,
        tuiPagesExtensionPointDefinition,
        toolCallReviewExtensionPointDefinition,
        toolCallRewriteExtensionPointDefinition,
        webApplicationsExtensionPointDefinition,
        webPagesExtensionPointDefinition,
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
