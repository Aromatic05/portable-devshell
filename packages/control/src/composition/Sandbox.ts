import {
    cliModelCommandsSandboxCodec,
    cliNativeCommandsSandboxCodec,
} from "../control/extension/cli/Sandbox.js";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../control/extension/toolcall/Sandbox.js";
import { ExtensionSandboxPointCodecRegistry } from "../control/extension/generation/sandbox/bridge/PointCodec.js";
import { webApplicationsSandboxCodec } from "../server/web/extension/Sandbox.js";

export function createControlExtensionSandboxPointRegistry(): ExtensionSandboxPointCodecRegistry {
    return new ExtensionSandboxPointCodecRegistry([
        cliModelCommandsSandboxCodec,
        cliNativeCommandsSandboxCodec,
        toolCallReviewSandboxCodec,
        toolCallRewriteSandboxCodec,
        webApplicationsSandboxCodec,
    ]);
}
