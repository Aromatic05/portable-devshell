import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { McpExtension } from "../protocol/extension/Contract.js";
import {
    mcpAppHtmlForPublicBaseUrl,
    mcpAppLegacyResourceUris,
    mcpAppResourceMetaForPublicBaseUrl,
    mcpAppResourceUri,
    mcpAppStableResourceUri,
} from "./app/App.js";

export function createMcpAppMcpExtension(
    publicBaseUrl?: string,
): McpExtension {
    const resourceMeta = mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl);
    const extension: McpExtension = {
        id: "mcpapp",
        presentation: {
            bootstrap: "environment",
            resourceUri: mcpAppResourceUri,
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
                    _meta: resourceMeta,
                    text: mcpAppHtmlForPublicBaseUrl(publicBaseUrl),
                }),
                uri: mcpAppResourceUri,
            }),
        ],
    };
    return Object.freeze(extension);
}
