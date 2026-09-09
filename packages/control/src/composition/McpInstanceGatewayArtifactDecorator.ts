import type { McpInstanceGateway } from "@portable-devshell/mcp";
import type {
    ArtifactViewImageInput,
    ArtifactViewImageResult
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
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        }
    });
}
