import { cliCommandsExtensionPointDefinition } from "../control/cli/CliExtensionPointDefinition.js";
import { ExtensionPointRegistry } from "../control/extension/host/generation/ExtensionPointRegistry.js";
import { webApplicationsExtensionPointDefinition } from "../server/web/extension/WebApplicationExtensionPointDefinition.js";

export function createControlExtensionPointRegistry(): ExtensionPointRegistry {
    return new ExtensionPointRegistry([
        cliCommandsExtensionPointDefinition,
        webApplicationsExtensionPointDefinition
    ]);
}
