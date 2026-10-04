import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    tools,
    type McpToolBinding,
    type McpToolDeclaration,
    type McpToolInvocationContext,
    type McpToolResult,
} from "@portable-devshell/extension/mcp";
import {
    presentToolCallResult,
    type ToolCallHooks,
} from "@portable-devshell/core/toolcall";
import { mcpAllInstances, mcpTools } from "@portable-devshell/mcp/tool";
import type {
    JsonValue,
    ToolCallPresentation,
    ToolDefinition,
} from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../host/Host.js";

export class McpExtensionService {
    readonly #extensions: Pick<
        ExtensionHost,
        | "acquireRegistration"
        | "contextEnvironmentRetired"
        | "listDeclarations"
        | "onChange"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            | "acquireRegistration"
            | "contextEnvironmentRetired"
            | "listDeclarations"
            | "onChange"
        >,
    ) {
        this.#extensions = extensions;
    }

    install(hooks: ToolCallHooks): () => void {
        const definitions = mcpTools.register(mcpAllInstances, []);
        const executes = new Map<string, () => void>();
        const sync = () => {
            const tools = this.#definitions();
            definitions.replace(tools);
            const active = new Set(tools.map((tool) => tool.name));
            for (const [toolName, unregister] of executes) {
                if (active.has(toolName)) continue;
                unregister();
                executes.delete(toolName);
            }
            for (const toolName of active) {
                if (executes.has(toolName)) continue;
                executes.set(
                    toolName,
                    hooks.registerExecute(
                        toolName,
                        async (callId, input, value, signal) => {
                            const result = await this.callTool(
                                toolName,
                                input,
                                {
                                    callId,
                                    ...(value.context.ctxId === undefined
                                        ? {}
                                        : { ctxId: value.context.ctxId }),
                                    instance: value.context.instance,
                                    ...(value.context.requestId === undefined
                                        ? {}
                                        : {
                                              requestId:
                                                  value.context.requestId,
                                          }),
                                    ...(value.context.workspace === undefined
                                        ? {}
                                        : {
                                              workspace:
                                                  value.context.workspace,
                                          }),
                                },
                                signal,
                            );
                            const presentation = toolPresentation(result);
                            const structured =
                                result.structuredContent as JsonValue;
                            return presentation === undefined
                                ? structured
                                : presentToolCallResult(
                                      structured,
                                      presentation,
                                  );
                        },
                    ),
                );
            }
        };
        const stopSync = this.#extensions.onChange(sync);
        sync();
        return () => {
            stopSync();
            for (const unregister of executes.values()) unregister();
            executes.clear();
            definitions.dispose();
        };
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
        reason: "disabled" | "expired",
    ): Promise<void> {
        await this.#extensions.contextEnvironmentRetired({
            ctxId,
            instance,
            reason,
        });
    }

    #definitions(): ToolDefinition[] {
        return this.#extensions
            .listDeclarations(tools.id)
            .map((registration) =>
                toolDefinition(
                    registration.extensionId,
                    registration.declaration as McpToolDeclaration,
                ),
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
            "MCP tool " + toolName + " result must include structuredContent.",
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

function toolPresentation(
    result: McpToolResult,
): ToolCallPresentation | undefined {
    if (result.content === undefined && result.isError === undefined)
        return undefined;
    return {
        ...(result.content === undefined
            ? {}
            : {
                  content: result.content.map((entry) => ({
                      text: entry.text,
                      type: "text" as const,
                  })),
              }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
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
