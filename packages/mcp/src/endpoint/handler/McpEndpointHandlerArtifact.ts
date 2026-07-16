import type { JsonValue } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../../tool/catalog/McpToolCatalogArtifact.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { readMcpArtifactShareInput, readMcpArtifactTransferInput } from "../McpEndpointInput.js";
import { mcpEndpointToolNotExposed, requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerArtifact {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(toolName: McpToolCatalogArtifactName, input: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
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
