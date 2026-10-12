import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePortableDevshellApplicationVersion } from "../../Version.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const assetRoot = join(packageRoot, "dist/mcpapp");
const manifest = JSON.parse(
    readFileSync(join(assetRoot, ".vite/manifest.json"), "utf8"),
) as Record<string, { file: string; css?: string[]; isEntry?: boolean }>;
const candidate = Object.values(manifest).find((item) => item.isEntry);
if (candidate === undefined || !candidate.file.startsWith("assets/"))
    throw new Error("The MCP App Vite manifest has no valid entrypoint.");
const entry: { file: string; css?: string[] } = candidate;

export const mcpAppAssetDirectory = join(assetRoot, "assets");
export const mcpAppStableResourceUri = "ui://portable-devshell/mcpapp/v1.html";
export const mcpAppLegacyResourceUris: readonly string[] = [
    "ui://portable-devshell/mcpapp-4c76f732a1682c7b.html",
    "ui://portable-devshell/workspace-651c9d0f1042c493.html",
    "ui://portable-devshell/workspace-98410baf51f694b0.html",
    "ui://portable-devshell/workspace-03c4911b6d185e3c.html",
    "ui://portable-devshell/workspace-c978585dba4e38c7.html",
    "ui://portable-devshell/workspace-4305d70d5fdb6a12.html",
];

export const mcpAppVersion = resolvePortableDevshellApplicationVersion();
export const mcpAppResourceUri = `ui://portable-devshell/mcpapp-${createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16)}.html`;
export const mcpAppInteractionStableResourceUri = "ui://portable-devshell/mcpapp/interaction/v1.html";
export const mcpAppInteractionResourceUri = `ui://portable-devshell/mcpapp-interaction-${createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16)}.html`;
export const mcpAppToolCallStableResourceUri = "ui://portable-devshell/mcpapp/toolcall/v1.html";
export const mcpAppToolCallResourceUri = `ui://portable-devshell/mcpapp-toolcall-${createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16)}.html`;
export type McpAppView = "workspace" | "interaction" | "toolcall";
export const mcpAppResourceUris = [mcpAppResourceUri, mcpAppStableResourceUri, ...mcpAppLegacyResourceUris, mcpAppInteractionResourceUri, mcpAppInteractionStableResourceUri, mcpAppToolCallResourceUri, mcpAppToolCallStableResourceUri] as const;

export const mcpAppResourceMeta = {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetDescription": "Portable-devshell MCP App",
    "openai/widgetPrefersBorder": false,
    "openai/ui": { availableDisplayModes: ["fullscreen"] },
} as const;

export function mcpAppResourceMetaForPublicBaseUrl(publicBaseUrl?: string, view: McpAppView = "workspace") {
    const meta = {
        ...mcpAppResourceMeta,
        "openai/ui": { availableDisplayModes: view === "workspace" ? ["fullscreen"] : ["inline"] },
    };
    if (publicBaseUrl === undefined) return meta;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]")
        return meta;
    const domain = url.origin;
    return {
        ...meta,
        ui: {
            ...mcpAppResourceMeta.ui,
            csp: { connectDomains: [domain], resourceDomains: [domain] },
            domain,
        },
        "openai/widgetCSP": { connect_domains: [domain], resource_domains: [domain] },
        "openai/widgetDomain": domain,
    } as const;
}

export function mcpAppHtmlForPublicBaseUrl(publicBaseUrl?: string, view: McpAppView = "workspace"): string {
    const assetUrl = (file: string): string => {
        if (!file.startsWith("assets/") || file.includes(".."))
            throw new Error("The MCP App Vite manifest contains an invalid asset path.");
        if (publicBaseUrl === undefined) return `/mcpapp/${file}`;
        const url = new URL(publicBaseUrl);
        url.pathname = `${url.pathname.replace(/\/+$/u, "")}/mcpapp/${file}`;
        url.search = "";
        url.hash = "";
        return url.href;
    };
    const styles = (entry.css ?? [])
        .map((file) => `<link rel="stylesheet" href="${escapeAttribute(assetUrl(file))}">`)
        .join("");
    return `<!doctype html><html lang="en" data-mcpapp-view="${view}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevShell Workspace</title>${styles}</head><body><div id="root"></div><script type="module" crossorigin src="${escapeAttribute(assetUrl(entry.file))}"></script></body></html>`;
}

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
