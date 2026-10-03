import {
    cliModelCommandsSandboxCodec,
    cliNativeCommandsSandboxCodec,
} from "../extension/api/point/cli/Sandbox.js";
import { controlRoutesSandboxCodec } from "../extension/api/point/control/Sandbox.js";
import { mcpToolsSandboxCodec } from "./mcp/extension/Sandbox.js";
import { tuiPagesSandboxCodec } from "../extension/api/point/tui/Sandbox.js";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../extension/api/point/toolcall/Sandbox.js";
import { ExtensionSandboxPointCodecRegistry } from "../extension/sandbox/bridge/PointCodec.js";
import {
    webApplicationsSandboxCodec,
    webPagesSandboxCodec,
} from "../server/web/extension/Sandbox.js";

export function createControlExtensionSandboxPointRegistry(): ExtensionSandboxPointCodecRegistry {
    return new ExtensionSandboxPointCodecRegistry([
        cliModelCommandsSandboxCodec,
        cliNativeCommandsSandboxCodec,
        controlRoutesSandboxCodec,
        mcpToolsSandboxCodec,
        tuiPagesSandboxCodec,
        toolCallReviewSandboxCodec,
        toolCallRewriteSandboxCodec,
        webApplicationsSandboxCodec,
        webPagesSandboxCodec,
    ]);
}
