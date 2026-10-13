import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePortableDevshellApplicationVersion } from "../../Version.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const assetRoot = join(packageRoot, "dist/mcpapp");
const manifest = JSON.parse(
    readFileSync(join(assetRoot, ".vite/manifest.json"), "utf8"),
) as Record<string, { file: string; css?: string[]; imports?: string[]; isEntry?: boolean }>;
const workspaceEntry = manifest["index.html"];
const toolCallEntry = manifest["toolcall.html"];
if (!workspaceEntry?.isEntry || !workspaceEntry.file.startsWith("assets/") ||
    !toolCallEntry?.isEntry || !toolCallEntry.file.startsWith("assets/"))
    throw new Error("The MCP App Vite manifest is missing a Workspace or ToolCall entrypoint.");

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
// Historical cards may request a content-hashed resource after a server upgrade.
const hashedWorkspaceUri = /^ui:\/\/portable-devshell\/mcpapp-[0-9a-f]{16}\.html$/u;
const hashedInteractionUri = /^ui:\/\/portable-devshell\/mcpapp-interaction-[0-9a-f]{16}\.html$/u;
const hashedToolCallUri = /^ui:\/\/portable-devshell\/mcpapp-toolcall-[0-9a-f]{16}\.html$/u;
const toolNamePattern = /^[a-zA-Z0-9_.:-]{1,128}$/u;

export const mcpAppIsHashedWorkspaceResourceUri = (uri: string): boolean =>
    hashedWorkspaceUri.test(uri);
export const mcpAppIsHashedInteractionResourceUri = (uri: string): boolean =>
    hashedInteractionUri.test(uri);

/** Distinct URI per tool, served by one immutable JS/CSS bundle. */
export function mcpAppToolCallResourceUriForTool(toolName: string): string {
    if (!toolNamePattern.test(toolName)) return mcpAppToolCallResourceUri;
    return mcpAppToolCallResourceUri + "?widgetRevision=1&toolName=" + encodeURIComponent(toolName);
}

/** Resolve only canonical resource variants, never arbitrary query strings. */
export function mcpAppToolCallToolNameFromUri(uri: string): string | undefined {
    const baseUri = uri.split("?", 1)[0]!;
    if (!isToolCallBaseUri(baseUri) || !uri.startsWith(baseUri + "?")) return undefined;
    try {
        const name = new URL(uri).searchParams.get("toolName");
        if (name && toolNamePattern.test(name) &&
            uri === baseUri + "?widgetRevision=1&toolName=" + encodeURIComponent(name))
            return name;
    } catch { /* Unknown resource. */ }
    return undefined;
}

/** Historical generic cards and per-tool cards share the current presentation bundle. */
export function mcpAppIsToolCallResourceUri(uri: string): boolean {
    const baseUri = uri.split("?", 1)[0]!;
    return isToolCallBaseUri(baseUri) &&
        (uri === baseUri || mcpAppToolCallToolNameFromUri(uri) !== undefined);
}

function isToolCallBaseUri(uri: string): boolean {
    return uri === mcpAppToolCallStableResourceUri || hashedToolCallUri.test(uri);
}
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

export function mcpAppHtmlForPublicBaseUrl(
    publicBaseUrl?: string, view: McpAppView = "workspace", toolName?: string,
): string {
    const entryName = view === "toolcall" ? "toolcall.html" : "index.html";
    const entry = view === "toolcall" ? toolCallEntry : workspaceEntry;
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
    const styles = entryStyles(entryName)
        .map((file) => `<link rel="stylesheet" href="${escapeAttribute(assetUrl(file))}">`)
        .join("");
    const toolAttribute = view === "toolcall" && toolName
        ? " data-tool-name=" + JSON.stringify(escapeAttribute(toolName))
        : "";
    return `<!doctype html><html lang="en" data-mcpapp-view="${view}"${toolAttribute}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevShell Workspace</title>${styles}</head><body><div id="root"></div><script type="module" crossorigin src="${escapeAttribute(assetUrl(entry.file))}"></script></body></html>`;
}

/** Vite may attach CSS to a shared static chunk rather than its HTML entry. */
function entryStyles(entryName: string): string[] {
    const visited = new Set<string>();
    const css = new Set<string>();
    const visit = (name: string) => {
        if (visited.has(name)) return;
        visited.add(name);
        const entry = manifest[name];
        if (!entry) throw new Error(`Missing MCP App Vite manifest dependency ${name}`);
        for (const file of entry.css ?? []) css.add(file);
        for (const dependency of entry.imports ?? []) visit(dependency);
    };
    visit(entryName);
    return [...css];
}

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
