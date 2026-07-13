import type { ToolDefinition } from "@portable-devshell/shared";

export type McpArtifactToolName = "artifact_share" | "artifact_transfer";

export class McpArtifactToolCatalog {
    list(): ToolDefinition[] {
        return [artifactShareTool(), artifactTransferTool()];
    }
}

function artifactShareTool(): ToolDefinition {
    return {
        description:
            "Create a temporary browser download link for a stdout or stderr artifact, regular file, or directory.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                { not: { required: ["path"] }, required: ["handle"] },
                { not: { required: ["handle"] }, required: ["path"] }
            ],
            properties: {
                expiresInSeconds: {
                    minimum: 60,
                    type: "integer"
                },
                handle: {
                    minLength: 1,
                    type: "string"
                },
                instance: {
                    description:
                        "Optional source instance. Defaults to the current endpoint instance.",
                    minLength: 1,
                    type: "string"
                },
                path: {
                    minLength: 1,
                    type: "string"
                }
            },
            type: "object"
        },
        name: "artifact_share",
        outputSchema: {
            additionalProperties: true,
            type: "object"
        },
        requiredCapabilities: ["read", "write"]
    };
}

function artifactTransferTool(): ToolDefinition {
    return {
        description:
            "Start, inspect, or cancel an asynchronous transfer of a stdout or stderr artifact, regular file, or directory between managed destinations.",
        group: "artifact",
        inputSchema: {
            additionalProperties: false,
            oneOf: [
                {
                    oneOf: [
                        { not: { required: ["sourcePath"] }, required: ["handle"] },
                        { not: { required: ["handle"] }, required: ["sourcePath"] }
                    ],
                    properties: {
                        handle: { minLength: 1, type: "string" },
                        instance: {
                            description:
                                "Optional source instance. Defaults to the current endpoint instance.",
                            minLength: 1,
                            type: "string"
                        },
                        operation: { const: "start" },
                        overwrite: { default: false, type: "boolean" },
                        sourcePath: { minLength: 1, type: "string" },
                        targetInstance: { minLength: 1, type: "string" },
                        targetPath: { minLength: 1, type: "string" }
                    },
                    required: ["operation", "targetInstance", "targetPath"],
                    type: "object"
                },
                {
                    properties: {
                        operation: { const: "status" },
                        transferId: { minLength: 1, type: "string" }
                    },
                    required: ["operation", "transferId"],
                    type: "object"
                },
                {
                    properties: {
                        operation: { const: "cancel" },
                        transferId: { minLength: 1, type: "string" }
                    },
                    required: ["operation", "transferId"],
                    type: "object"
                }
            ],
            type: "object"
        },
        name: "artifact_transfer",
        outputSchema: {
            additionalProperties: true,
            type: "object"
        },
        requiredCapabilities: ["read", "write"]
    };
}
