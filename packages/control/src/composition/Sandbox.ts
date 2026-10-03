import {
    cliModelCommandsSandboxCodec,
    cliNativeCommandsSandboxCodec,
} from "../extension/cli/Sandbox.js";
import { controlRoutesSandboxCodec } from "../extension/Route.js";
import { mcpToolsSandboxCodec } from "./mcp/extension/Sandbox.js";
import { tuiPagesSandboxCodec } from "../extension/tui/Sandbox.js";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../extension/toolcall/Sandbox.js";
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
