import type { ToolDefinition } from "@portable-devshell/shared";

export type McpToolCatalogArtifactName = "artifact_viewImage";

export interface McpToolCatalogArtifactAvailability {
    viewImage?: boolean;
}

export class McpToolCatalogArtifact {
    list(availability: McpToolCatalogArtifactAvailability = { viewImage: true }): ToolDefinition[] {
        return availability.viewImage === true ? [artifactViewImageTool()] : [];
    }
}

function artifactViewImageTool(): ToolDefinition {
    return {
        description: "View a PNG, JPEG, GIF, or WebP source as native MCP image content. Provide exactly one of path or handle. The selected source instance is read through the existing artifact payload protocol; images larger than 10 MiB are rejected.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                { not: { required: ["path"] }, required: ["handle"] },
                { not: { required: ["handle"] }, required: ["path"] }
            ],
            properties: {
                handle: {
                    description: "Artifact handle returned by a previous artifact-producing tool result. Mutually exclusive with path.",
                    minLength: 1,
                    type: "string"
                },
                path: {
                    description: "Image file path on the selected source instance. Mutually exclusive with handle.",
                    minLength: 1,
                    type: "string"
                }
            },
            type: "object"
        },
        name: "artifact_viewImage",
        outputSchema: {
            additionalProperties: false,
            properties: {
                bytes: { minimum: 1, type: "integer" },
                mediaType: { enum: ["image/png", "image/jpeg", "image/gif", "image/webp"], type: "string" },
                name: { minLength: 1, type: "string" },
                source: {
                    additionalProperties: false,
                    oneOf: [
                        { not: { required: ["path"] }, required: ["handle"] },
                        { not: { required: ["handle"] }, required: ["path"] }
                    ],
                    properties: {
                        handle: { minLength: 1, type: "string" },
                        instance: { minLength: 1, type: "string" },
                        path: { minLength: 1, type: "string" },
                        type: { enum: ["artifact", "file"], type: "string" },
                        workspace: { minLength: 1, type: "string" }
                    },
                    required: ["instance", "type"],
                    type: "object"
                }
            },
            required: ["bytes", "mediaType", "name", "source"],
            type: "object"
        },
        requiredCapabilities: ["read"]
    };
}
