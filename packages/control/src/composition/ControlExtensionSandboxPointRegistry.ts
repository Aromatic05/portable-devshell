import { cliCommandsSandboxCodec } from "../control/cli/CliExtensionSandboxCodec.js";
import { ExtensionSandboxPointCodecRegistry } from "../control/extension/host/generation/sandbox/ExtensionSandboxPointCodec.js";
import { webApplicationsSandboxCodec } from "../server/web/extension/WebApplicationExtensionSandboxCodec.js";

export function createControlExtensionSandboxPointRegistry(): ExtensionSandboxPointCodecRegistry {
    return new ExtensionSandboxPointCodecRegistry([
        cliCommandsSandboxCodec,
        webApplicationsSandboxCodec
    ]);
}
