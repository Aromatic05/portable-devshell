import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    contextTerminal,
    tools,
    type McpContextTerminalBinding,
    type McpContextTerminalReason,
    type McpToolBinding,
    type McpToolDeclaration,
    type McpToolInvocationContext,
    type McpToolResult,
} from "@portable-devshell/extension/mcp";
import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../control/extension/Host.js";

export class McpExtensionService {
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
    ) {
        this.#extensions = extensions;
    }

    listTools(): readonly ToolDefinition[] {
        return this.#extensions.listDeclarations(tools.id).map((registration) =>
            toolDefinition(
                registration.extensionId,
                registration.declaration as McpToolDeclaration,
            ),
        );
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        context: Omit<McpToolInvocationContext, "signal">,
        signal?: AbortSignal,
    ): Promise<McpToolResult> {
        const { lease, registration } =
            await this.#extensions.acquireRegistration(tools.id, toolName);
        try {
            if (typeof registration.binding !== "function")
                throw new TypeError(
                    "MCP tool " +
                        toolName +
                        " has an invalid Extension binding.",
                );
            return validateToolResult(
                await (registration.binding as McpToolBinding)(
                    input as ExtensionJsonValue,
                    Object.freeze({
                        ...context,
                        signal: signal ?? new AbortController().signal,
                    }),
                ),
                toolName,
            );
        } finally {
            lease.release();
        }
    }

    async contextTerminated(
        instance: string,
        ctxId: string,
        reason: McpContextTerminalReason,
    ): Promise<void> {
        const failures: unknown[] = [];
        for (const declaration of this.#extensions.listDeclarations(
            contextTerminal.id,
        )) {
            try {
                const { lease, registration } =
                    await this.#extensions.acquireRegistration(
                        contextTerminal.id,
                        declaration.id,
                    );
                try {
                    if (typeof registration.binding !== "function")
                        throw new TypeError(
                            "MCP Context terminal " +
                                declaration.id +
                                " has an invalid Extension binding.",
                        );
                    await (registration.binding as McpContextTerminalBinding)({
                        ctxId,
                        instance,
                        reason,
                    });
                } finally {
                    lease.release();
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(
                failures,
                "MCP Context " +
                    ctxId +
                    " terminal Extension cleanup was incomplete.",
            );
    }
}

function toolDefinition(
    extensionId: string,
    declaration: McpToolDeclaration,
): ToolDefinition {
    const annotations = compact({
        destructiveHint: declaration.destructiveHint,
        idempotentHint: declaration.idempotentHint,
        openWorldHint: declaration.openWorldHint,
        readOnlyHint: declaration.readOnlyHint,
    });
    const mcp = compact({
        activity: declaration.activity,
        annotations:
            Object.keys(annotations).length === 0 ? undefined : annotations,
        extensionTool: true,
        invoked: declaration.invoked,
        invoking: declaration.invoking,
        preserveInputDescriptions: true,
        title: declaration.title,
    });
    return {
        _meta: {
            devshell: {
                extensionId,
                mcp,
            },
        },
        description: declaration.description,
        group: declaration.id.slice(0, declaration.id.indexOf("_")),
        inputSchema: declaration.inputSchema as JsonValue,
        name: declaration.id,
        outputSchema: declaration.outputSchema as JsonValue,
        requiredCapabilities: [],
    };
}

function validateToolResult(value: unknown, toolName: string): McpToolResult {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError(
            "MCP tool " + toolName + " result must be an object.",
        );
    const result = value as Partial<McpToolResult>;
    if (!("structuredContent" in result))
        throw new TypeError(
            "MCP tool " +
                toolName +
                " result must include structuredContent.",
        );
    if (result.isError !== undefined && typeof result.isError !== "boolean")
        throw new TypeError(
            "MCP tool " + toolName + " result isError must be a boolean.",
        );
    if (
        result.content !== undefined &&
        (!Array.isArray(result.content) ||
            result.content.some(
                (entry) =>
                    typeof entry !== "object" ||
                    entry === null ||
                    entry.type !== "text" ||
                    typeof entry.text !== "string",
            ))
    )
        throw new TypeError(
            "MCP tool " +
                toolName +
                " result content must contain text entries.",
        );
    return Object.freeze({
        ...(result.content === undefined
            ? {}
            : {
                  content: Object.freeze(
                      result.content.map((entry) =>
                          Object.freeze({
                              text: entry.text,
                              type: "text" as const,
                          }),
                      ),
                  ),
              }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        structuredContent: result.structuredContent as ExtensionJsonValue,
    });
}

function compact(
    value: Record<string, ExtensionJsonValue | undefined>,
): Record<string, ExtensionJsonValue> {
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, ExtensionJsonValue] =>
                entry[1] !== undefined,
        ),
    );
}
