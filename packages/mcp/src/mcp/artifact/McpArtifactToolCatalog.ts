import type { ToolDefinition } from "@portable-devshell/shared";

export type McpArtifactToolName = "artifact_share" | "artifact_transfer";

export class McpArtifactToolCatalog {
    list(): ToolDefinition[] {
        return [artifactShareTool(), artifactTransferTool()];
    }
}

function artifactShareTool(): ToolDefinition {
    return {
        description: "Create a temporary browser download link for an artifact, file, or directory.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                { not: { required: ["path"] }, required: ["handle"] },
                { not: { required: ["handle"] }, required: ["path"] }
            ],
            properties: {
                expiresInSeconds: { minimum: 60, type: "integer" },
                handle: { minLength: 1, type: "string" },
                path: { minLength: 1, type: "string" }
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
        description: "Start, inspect, or cancel an asynchronous file or artifact transfer between managed instances.",
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
                handle: { minLength: 1, type: "string" },
                operation: { enum: ["start", "status", "cancel"], type: "string" },
                overwrite: { default: false, type: "boolean" },
                sourcePath: { minLength: 1, type: "string" },
                targetInstance: { minLength: 1, type: "string" },
                targetPath: { minLength: 1, type: "string" },
                transferId: { minLength: 1, type: "string" }
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
