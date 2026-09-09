import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";

import { executeArtifactCommand } from "./ArtifactCommand.js";
import { executeArtifactModelCommand } from "./ArtifactModelCommand.js";

export { ARTIFACT_USAGE, executeArtifactCommand } from "./ArtifactCommand.js";
export { ARTIFACT_MODEL_USAGE, executeArtifactModelCommand } from "./ArtifactModelCommand.js";

export function activate(context: ExtensionContext): void {
    const artifacts = context.capabilities.artifacts;
    if (artifacts === undefined) throw new Error("Artifact Extension requires the artifacts capability.");
    context.register(nativeCommands, "artifact", async (argv, invocation) =>
        await executeArtifactCommand(artifacts, argv, invocation.signal)
    );
    context.register(modelCommands, "artifact", async (argv, invocation) =>
        await executeArtifactModelCommand(artifacts, argv, invocation)
    );
}
