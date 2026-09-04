import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../../tool/catalog/McpToolCatalogArtifact.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import {
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
        context: ToolCallContext,
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
                        readMcpArtifactViewImageInput(withSourceWorkspace(input, context)),
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
                    content: [{
                        data: image.content,
                        mimeType: image.mediaType,
                        type: "image"
                    }],
                    structuredContent
                });
            }
            case "artifact_transfer":
                if (gateway.transferArtifact === undefined) {
                    throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
                }
                return await waitForMcpEndpointAbortable(
                    gateway.transferArtifact(this.options.instanceName, readMcpArtifactTransferInput(withTransferWorkspace(input, context))),
                    signal
                );
        }
    }
}

function requireContextWorkspace(context: ToolCallContext): string {
    if (context.workspace !== undefined && context.workspace.length > 0) return context.workspace;
    throw createError({
        code: errorCodes.mcpContextWorkspaceRequired,
        details: context.ctxId === undefined ? undefined : { ctxId: context.ctxId },
        message: "Artifact path operations require a workspace attachment on the selected instance.",
        retryable: false
    });
}

function withSourceWorkspace(input: JsonValue, context: ToolCallContext): JsonValue {
    if (!isRecord(input) || input.path === undefined) return input;
    return { ...input, workspace: requireContextWorkspace(context) };
}

function withTransferWorkspace(input: JsonValue, context: ToolCallContext): JsonValue {
    if (!isRecord(input) || input.operation !== "start" || input.sourcePath === undefined) return input;
    return { ...input, sourceWorkspace: requireContextWorkspace(context) };
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
