import {
    cliModelCommandsExtensionPointDefinition,
    cliNativeCommandsExtensionPointDefinition,
} from "../api/point/cli/Declaration.js";
import {
    cliModelCommandsSandboxCodec,
    cliNativeCommandsSandboxCodec,
} from "../api/point/cli/Sandbox.js";
import { controlRoutesExtensionPointDefinition } from "../api/point/control/Declaration.js";
import { controlRoutesSandboxCodec } from "../api/point/control/Sandbox.js";
import { controlStreamsExtensionPointDefinition, controlStreamsSandboxCodec } from "../api/point/control/Stream.js";
import { executionEnvironmentExtensionPointDefinition, executionSandboxExtensionPointDefinition } from "../api/point/execution/Declaration.js";
import { executionEnvironmentSandboxCodec, executionSandboxSandboxCodec } from "../api/point/execution/Sandbox.js";
import { mcpToolsExtensionPointDefinition } from "../api/point/mcp/Declaration.js";
import { mcpToolsSandboxCodec } from "../api/point/mcp/Sandbox.js";
import {
    toolCallReviewExtensionPointDefinition,
    toolCallRewriteExtensionPointDefinition,
} from "../api/point/toolcall/Declaration.js";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../api/point/toolcall/Sandbox.js";
import { tuiPagesExtensionPointDefinition } from "../api/point/tui/Declaration.js";
import { tuiPagesSandboxCodec } from "../api/point/tui/Sandbox.js";
import {
    webApplicationsExtensionPointDefinition,
    webPagesExtensionPointDefinition,
} from "../api/point/web/Declaration.js";
import {
    webApplicationsSandboxCodec,
    webPagesSandboxCodec,
} from "../api/point/web/Sandbox.js";
import { ExtensionSandboxPointCodecRegistry } from "../sandbox/bridge/PointCodec.js";
import { ExtensionPointRegistry } from "./PointRegistry.js";

export function createControlExtensionPointRegistry(): ExtensionPointRegistry {
    const points = new ExtensionPointRegistry([
        cliModelCommandsExtensionPointDefinition,
        cliNativeCommandsExtensionPointDefinition,
        controlRoutesExtensionPointDefinition,
        controlStreamsExtensionPointDefinition,
        executionEnvironmentExtensionPointDefinition,
        executionSandboxExtensionPointDefinition,
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

export function createControlExtensionSandboxPointRegistry(): ExtensionSandboxPointCodecRegistry {
    return new ExtensionSandboxPointCodecRegistry([
        cliModelCommandsSandboxCodec,
        cliNativeCommandsSandboxCodec,
        controlRoutesSandboxCodec,
        controlStreamsSandboxCodec,
        executionEnvironmentSandboxCodec,
        executionSandboxSandboxCodec,
        mcpToolsSandboxCodec,
        tuiPagesSandboxCodec,
        toolCallReviewSandboxCodec,
        toolCallRewriteSandboxCodec,
        webApplicationsSandboxCodec,
        webPagesSandboxCodec,
    ]);
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
