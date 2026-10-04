import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    tools,
    type McpToolBinding,
    type McpToolInvocationContext,
    type McpToolResult,
} from "@portable-devshell/extension/mcp";
import type { JsonValue } from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../extension/host/Host.js";

export class McpExtensionService {
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "contextEnvironmentRetired"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "contextEnvironmentRetired"
        >,
    ) {
        this.#extensions = extensions;
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
