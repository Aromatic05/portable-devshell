import type { JsonValue } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../../tool/catalog/McpToolCatalogArtifact.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import {
    readMcpArtifactShareInput,
    readMcpArtifactTransferInput,
    readMcpArtifactViewImageInput
} from "../McpEndpointInput.js";
import { McpNativeToolResult, type McpEndpointResult } from "../McpEndpointResult.js";
import { mcpEndpointToolNotExposed, requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerArtifact {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(
        toolName: McpToolCatalogArtifactName,
        input: JsonValue,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "artifact_viewImage": {
                if (gateway.viewArtifactImage === undefined) {
                    throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
                }
                const image = await waitForMcpEndpointAbortable(
                    gateway.viewArtifactImage(
                        this.options.instanceName,
                        readMcpArtifactViewImageInput(input),
                        signal
                    ),
                    signal
                );
                const structuredContent = {
                    bytes: image.bytes,
                    mediaType: image.mediaType,
                    name: image.name,
                    source: image.source
                } as unknown as JsonValue;
                return new McpNativeToolResult({
                    content: [
                        {
                            data: image.content,
                            mimeType: image.mediaType,
                            type: "image"
                        },
                        {
                            text: `${image.name} (${image.mediaType}, ${image.bytes} bytes)`,
                            type: "text"
                        }
                    ],
                    structuredContent
                });
            }
            case "artifact_share":
                if (gateway.shareArtifact === undefined) {
                    throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
                }
                return await waitForMcpEndpointAbortable(
                    gateway.shareArtifact(this.options.instanceName, readMcpArtifactShareInput(input)),
                    signal
                );
            case "artifact_transfer":
                if (gateway.transferArtifact === undefined) {
                    throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
                }
                return await waitForMcpEndpointAbortable(
                    gateway.transferArtifact(this.options.instanceName, readMcpArtifactTransferInput(input)),
                    signal
                );
        }
    }
}
