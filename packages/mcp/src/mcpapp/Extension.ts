import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { McpExtension } from "../protocol/extension/Contract.js";
import {
    mcpAppHtmlForPublicBaseUrl,
    mcpAppLegacyResourceUris,
    mcpAppResourceMetaForPublicBaseUrl,
    mcpAppResourceUri,
    mcpAppInteractionResourceUri,
    mcpAppInteractionStableResourceUri,
    mcpAppStableResourceUri,
    mcpAppToolCallResourceUri,
    mcpAppToolCallResourceUriForTool,
    mcpAppToolCallToolNameFromUri,
    mcpAppToolCallStableResourceUri,
    mcpAppIsToolCallResourceUri,
    mcpAppIsHashedWorkspaceResourceUri,
    mcpAppIsHashedInteractionResourceUri,
} from "./app/App.js";

const inlineToolCalls = new Set([
    "artifact_viewImage", "bash_run", "file_edit", "file_read", "tmux_run",
]);

export function createMcpAppMcpExtension(
    publicBaseUrl?: string,
    options: { inlineToolCalls?: boolean } = {},
): McpExtension {
    const workspaceMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl, "workspace");
    const interactionMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl, "interaction");
    const toolCallMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl, "toolcall");
    const extension: McpExtension = {
        id: "mcpapp",
        presentation: {
            bootstrap: "environment",
            resourceUri: mcpAppResourceUri,
            interactionResourceUri: mcpAppInteractionResourceUri,
            // Returning undefined suppresses the environment bootstrap's
            // Fullscreen fallback when Inline ToolCall UI is disabled.
            toolCallResourceUriForTool: (name) => options.inlineToolCalls === true &&
                inlineToolCalls.has(name) ? mcpAppToolCallResourceUriForTool(name) : undefined,
        },
        resources: [
            Object.freeze({
                aliases: [
                    mcpAppStableResourceUri,
                    ...mcpAppLegacyResourceUris,
                ],
                app: true,
                matchesUri: mcpAppIsHashedWorkspaceResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                name: "portable-devshell MCP App",
                read: () => ({
                    _meta: workspaceMeta,
                    text: mcpAppHtmlForPublicBaseUrl(publicBaseUrl, "workspace"),
                }),
                uri: mcpAppResourceUri,
            }),
            Object.freeze({
                aliases: [mcpAppInteractionStableResourceUri],
                app: true,
                matchesUri: mcpAppIsHashedInteractionResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                name: "portable-devshell MCP App Interaction",
                read: () => ({
                    _meta: interactionMeta,
                    text: mcpAppHtmlForPublicBaseUrl(publicBaseUrl, "interaction"),
                }),
                uri: mcpAppInteractionResourceUri,
            }),
            Object.freeze({
                aliases: [mcpAppToolCallStableResourceUri],
                app: true,
                matchesUri: mcpAppIsToolCallResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                name: "portable-devshell ToolCall Inline",
                read: (uri: string) => ({
                    _meta: toolCallMeta,
                    text: mcpAppHtmlForPublicBaseUrl(publicBaseUrl, "toolcall",
                        mcpAppToolCallToolNameFromUri(uri)),
                }),
                uri: mcpAppToolCallResourceUri,
            }),
        ],
    };
    return Object.freeze(extension);
}
