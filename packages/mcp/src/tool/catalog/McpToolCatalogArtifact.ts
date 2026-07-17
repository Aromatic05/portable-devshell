import type { ToolDefinition } from "@portable-devshell/shared";

export type McpToolCatalogArtifactName = "artifact_viewImage" | "artifact_share" | "artifact_transfer";

export interface McpToolCatalogArtifactAvailability {
    share?: boolean;
    transfer?: boolean;
    viewImage?: boolean;
}

export class McpToolCatalogArtifact {
    list(availability: McpToolCatalogArtifactAvailability = {
        share: true,
        transfer: true,
        viewImage: true
    }): ToolDefinition[] {
        return [
            ...(availability.viewImage === true ? [artifactViewImageTool()] : []),
            ...(availability.share === true ? [artifactShareTool()] : []),
            ...(availability.transfer === true ? [artifactTransferTool()] : [])
        ];
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
                        type: { enum: ["artifact", "file"], type: "string" }
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

function artifactShareTool(): ToolDefinition {
    return {
        description: "Create a temporary browser download link for a file, directory, or artifact. Provide exactly one of path or handle. path is resolved on the selected source instance; handle must come from a previous artifact-producing tool result. expiresInSeconds defaults to 3600 and must be between 60 and 604800.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                { not: { required: ["path"] }, required: ["handle"] },
                { not: { required: ["handle"] }, required: ["path"] }
            ],
            properties: {
                expiresInSeconds: {
                    description: "Link lifetime in seconds. Defaults to 3600; allowed range is 60 through 604800.",
                    maximum: 604800,
                    minimum: 60,
                    type: "integer"
                },
                handle: {
                    description: "Artifact handle returned by a previous artifact-producing tool result. Mutually exclusive with path.",
                    minLength: 1,
                    type: "string"
                },
                path: {
                    description: "File or directory path on the selected source instance. Mutually exclusive with handle.",
                    minLength: 1,
                    type: "string"
                }
            },
            type: "object"
        },
        name: "artifact_share",
        outputSchema: {
            additionalProperties: true,
            properties: {
                expiresAtMs: { minimum: 0, type: "integer" },
                shareId: { minLength: 1, type: "string" },
                url: { minLength: 1, type: "string" }
            },
            required: ["shareId", "url", "expiresAtMs"],
            type: "object"
        },
        requiredCapabilities: ["read", "write"]
    };
}

function artifactTransferTool(): ToolDefinition {
    const nonStartFields = ["handle", "sourcePath", "targetInstance", "targetPath", "overwrite"]
        .map((field) => ({ required: [field] }));
    return {
        description: "Manage an asynchronous transfer between managed instances. For operation=start, provide exactly one of sourcePath or handle, plus targetInstance and targetPath; overwrite defaults to false. The returned transferId is used with operation=status or operation=cancel.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                {
                    oneOf: [
                        { not: { required: ["sourcePath"] }, required: ["handle"] },
                        { not: { required: ["handle"] }, required: ["sourcePath"] }
                    ],
                    properties: { operation: { const: "start" } },
                    required: ["operation", "targetInstance", "targetPath"]
                },
                {
                    not: { anyOf: nonStartFields },
                    properties: { operation: { const: "status" } },
                    required: ["operation", "transferId"]
                },
                {
                    not: { anyOf: nonStartFields },
                    properties: { operation: { const: "cancel" } },
                    required: ["operation", "transferId"]
                }
            ],
            properties: {
                handle: {
                    description: "Artifact handle returned by a previous artifact-producing tool result on the source instance. Mutually exclusive with sourcePath.",
                    minLength: 1,
                    type: "string"
                },
                operation: {
                    description: "start begins a transfer, status reads its current state, and cancel requests cancellation.",
                    enum: ["start", "status", "cancel"],
                    type: "string"
                },
                overwrite: {
                    default: false,
                    description: "Whether an existing target may be replaced. Defaults to false.",
                    type: "boolean"
                },
                sourcePath: {
                    description: "File or directory path on the source instance. Mutually exclusive with handle.",
                    minLength: 1,
                    type: "string"
                },
                targetInstance: {
                    description: "Managed destination instance name returned by instance_list.",
                    minLength: 1,
                    type: "string"
                },
                targetPath: {
                    description: "Destination file or directory path on targetInstance.",
                    minLength: 1,
                    type: "string"
                },
                transferId: {
                    description: "Transfer ID returned by operation=start; required for operation=status or operation=cancel.",
                    minLength: 1,
                    type: "string"
                }
            },
            required: ["operation"],
            type: "object"
        },
        name: "artifact_transfer",
        outputSchema: {
            additionalProperties: false,
            properties: {
                operation: { enum: ["start", "status", "cancel"], type: "string" },
                transfer: { type: "object" }
            },
            required: ["operation", "transfer"],
            type: "object"
        },
        requiredCapabilities: ["read", "write"]
    };
}
