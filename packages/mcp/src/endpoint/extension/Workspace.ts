import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import type { McpExtension } from "./Contract.js";
import {
    workspaceAppHtml,
    workspaceAppLegacyResourceUris,
    workspaceAppResourceMetaForPublicBaseUrl,
    workspaceAppResourceUri,
    workspaceAppStableResourceUri,
} from "../../workspace/app/App.js";

export function createWorkspaceMcpExtension(
    publicBaseUrl?: string,
): McpExtension {
    const resourceMeta = workspaceAppResourceMetaForPublicBaseUrl(publicBaseUrl);
    const extension: McpExtension = {
        id: "workspace",
        presentation: {
            bootstrap: "environment",
            resourceUri: workspaceAppResourceUri,
        },
        resources: [
            Object.freeze({
                aliases: [
                    workspaceAppStableResourceUri,
                    ...workspaceAppLegacyResourceUris,
                ],
                app: true,
                mimeType: RESOURCE_MIME_TYPE,
                name: "portable-devshell Workspace",
                read: () => ({
                    _meta: resourceMeta,
                    text: workspaceAppHtml,
                }),
                uri: workspaceAppResourceUri,
            }),
        ],
    };
    return Object.freeze(extension);
}
