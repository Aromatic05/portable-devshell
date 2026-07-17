import type { McpInstanceGateway } from "@portable-devshell/mcp";
import type {
    ArtifactShareInput,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    JsonValue
} from "@portable-devshell/shared";

import type { ArtifactService } from "../control/artifact/ArtifactService.js";

export function decorateMcpInstanceGatewayArtifact(
    base: McpInstanceGateway,
    artifactService: ArtifactService
): McpInstanceGateway {
    return new Proxy(base, {
        get(target, property, receiver) {
            if (property === "viewArtifactImage") {
                return async (
                    defaultInstance: string,
                    input: ArtifactViewImageInput,
                    signal?: AbortSignal
                ): Promise<ArtifactViewImageResult> =>
                    await artifactService.viewImage(input, defaultInstance, signal);
            }
            if (property === "shareArtifact") {
                return async (defaultInstance: string, input: ArtifactShareInput): Promise<JsonValue> =>
                    (await artifactService.createShare(input, defaultInstance)) as unknown as JsonValue;
            }
            if (property === "transferArtifact") {
                return async (
                    defaultInstance: string,
                    input:
                        | ArtifactTransferStartInput
                        | ArtifactTransferLookupInput
                        | ArtifactTransferCancelInput
                ): Promise<JsonValue> => {
                    switch (input.operation) {
                        case "start":
                            return (await artifactService.startTransfer(
                                input,
                                defaultInstance
                            )) as unknown as JsonValue;
                        case "status":
                            return (await artifactService.lookupTransfer(input)) as unknown as JsonValue;
                        case "cancel":
                            return (await artifactService.cancelTransfer(input)) as unknown as JsonValue;
                    }
                };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        }
    });
}
