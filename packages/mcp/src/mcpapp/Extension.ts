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
    mcpAppToolCallStableResourceUri,
} from "./app/App.js";

export function createMcpAppMcpExtension(
    publicBaseUrl?: string,
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
            toolCallResourceUri: mcpAppToolCallResourceUri,
        },
        resources: [
            Object.freeze({
                aliases: [
                    mcpAppStableResourceUri,
                    ...mcpAppLegacyResourceUris,
                ],
                app: true,
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
                mimeType: RESOURCE_MIME_TYPE,
                name: "portable-devshell ToolCall Inline",
                read: () => ({
                    _meta: toolCallMeta,
                    text: mcpAppHtmlForPublicBaseUrl(publicBaseUrl, "toolcall"),
                }),
                uri: mcpAppToolCallResourceUri,
            }),
        ],
    };
    return Object.freeze(extension);
}
