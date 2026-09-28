import {
    cliModelCommandsSandboxCodec,
    cliNativeCommandsSandboxCodec,
} from "../control/extension/cli/Sandbox.js";
import { controlRoutesSandboxCodec } from "../control/extension/Route.js";
import {
    mcpContextTerminalSandboxCodec,
    mcpToolsSandboxCodec,
} from "./mcp/extension/Sandbox.js";
import { tuiPagesSandboxCodec } from "../control/extension/tui/Sandbox.js";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../control/extension/toolcall/Sandbox.js";
import { ExtensionSandboxPointCodecRegistry } from "../control/extension/generation/sandbox/bridge/PointCodec.js";
import {
    webApplicationsSandboxCodec,
    webPagesSandboxCodec,
} from "../server/web/extension/Sandbox.js";

export function createControlExtensionSandboxPointRegistry(): ExtensionSandboxPointCodecRegistry {
    return new ExtensionSandboxPointCodecRegistry([
        cliModelCommandsSandboxCodec,
        cliNativeCommandsSandboxCodec,
        controlRoutesSandboxCodec,
        mcpContextTerminalSandboxCodec,
        mcpToolsSandboxCodec,
        tuiPagesSandboxCodec,
        toolCallReviewSandboxCodec,
        toolCallRewriteSandboxCodec,
        webApplicationsSandboxCodec,
        webPagesSandboxCodec,
    ]);
}
