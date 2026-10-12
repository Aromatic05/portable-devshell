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
} from "./app/App.js";

export function createMcpAppMcpExtension(
    publicBaseUrl?: string,
): McpExtension {
    const workspaceMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl, "workspace");
    const interactionMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl, "interaction");
    const extension: McpExtension = {
        id: "mcpapp",
        presentation: {
            bootstrap: "environment",
            resourceUri: mcpAppResourceUri,
            interactionResourceUri: mcpAppInteractionResourceUri,
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
        ],
    };
    return Object.freeze(extension);
}
