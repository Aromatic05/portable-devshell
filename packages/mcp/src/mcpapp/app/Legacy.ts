import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePortableDevshellApplicationVersion } from "../../Version.js";

const bundlePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
    "dist/mcpapp-client.js",
);
const clientBundle = readFileSync(bundlePath, "utf8").trim();
const mcpAppSdkScript = loadMcpAppSdkScript();
for (const script of [mcpAppSdkScript, clientBundle]) if (script.toLowerCase().includes("</script")) throw new Error("McpApp script cannot be embedded safely in HTML.");

export const mcpAppStableResourceUri =
    "ui://portable-devshell/mcpapp/v1.html";
export const mcpAppLegacyResourceUris: readonly string[] = [
    "ui://portable-devshell/workspace-651c9d0f1042c493.html",
    "ui://portable-devshell/workspace-98410baf51f694b0.html",
    "ui://portable-devshell/workspace-03c4911b6d185e3c.html",
    "ui://portable-devshell/workspace-c978585dba4e38c7.html",
    "ui://portable-devshell/workspace-4305d70d5fdb6a12.html",
];
export const mcpAppResourceMeta = {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetDescription": "Portable-devshell MCP App",
    "openai/widgetPrefersBorder": false,
} as const;

export function mcpAppResourceMetaForPublicBaseUrl(
    publicBaseUrl?: string,
) {
    if (publicBaseUrl === undefined) return mcpAppResourceMeta;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]")
        return mcpAppResourceMeta;
    const domain = url.origin;
    return {
        ...mcpAppResourceMeta,
        ui: { ...mcpAppResourceMeta.ui, csp: { connectDomains: [domain], resourceDomains: [] }, domain },
        "openai/widgetCSP": { connect_domains: [domain], resource_domains: [] },
        "openai/widgetDomain": domain,
    } as const;
}

export const mcpAppVersion = resolvePortableDevshellApplicationVersion();
export const mcpAppHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,CanvasText)}*{box-sizing:border-box}body{margin:0;padding:7px;font-size:13px}.grid{display:grid;gap:5px}.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:9px;overflow:hidden}.head,.row{display:flex;align-items:center;justify-content:space-between;gap:8px}.head{padding:4px 9px 2px;font-size:12px}.body{padding:0 9px 8px;font-size:12px;line-height:1.35}.muted{opacity:.68;font-size:11px}.badge{font-size:10px;border-radius:99px;padding:2px 7px;background:color-mix(in srgb,CanvasText 10%,transparent)}button,input{font:inherit;color:inherit}button:disabled{opacity:.55}.action,.choice-row{width:100%;min-height:34px;padding:7px 9px;text-align:left;border:0;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:0;background:transparent;font-size:12px;cursor:pointer}.action[data-tone=danger]{color:var(--color-text-danger,CanvasText)}.choice-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.choice-row:hover{background:color-mix(in srgb,CanvasText 6%,transparent)}.choice-list[data-expanded=true]{max-height:102px;overflow-y:auto}.work-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr))}.work-actions .action:only-child{grid-column:1/-1}.question-input{display:flex;gap:6px;padding:4px 7px;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent)}.question-input input{min-width:0;flex:1;padding:7px;border:0;background:transparent}.background-controls{display:flex;gap:8px}.background-controls .action{width:auto;border:0}.row button{font-size:12px;padding:4px 8px}#status:empty{display:none}</style></head><body><small id="status" role="status"></small><main id="root" class="grid"></main><script>${mcpAppSdkScript}</script><script>${clientBundle}</script><script>globalThis.McpAppClient.mount({version:${JSON.stringify(mcpAppVersion)}});</script></body></html>`;
export const mcpAppResourceUri = `ui://portable-devshell/mcpapp-${createHash("sha256").update(mcpAppHtml).digest("hex").slice(0, 16)}.html`;
export const mcpAppResourceUris = [mcpAppResourceUri, mcpAppStableResourceUri, ...mcpAppLegacyResourceUris] as const;

function loadMcpAppSdkScript(): string {
    const path = fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
    const source = readFileSync(path, "utf8").trimEnd();
    const exportBlock = source.match(/export\{([\s\S]+)\};$/);
    const exports = exportBlock?.[1];
    const symbol = (name: string) => exports?.match(new RegExp(`(?:^|,)\\s*([$A-Za-z_][$\\w]*)\\s+as\\s+${name}\\s*(?:,|$)`))?.[1];
    const names = { App: symbol("App"), applyDocumentTheme: symbol("applyDocumentTheme"), applyHostStyleVariables: symbol("applyHostStyleVariables"), applyHostFonts: symbol("applyHostFonts") };
    if (exportBlock?.index === undefined || Object.values(names).some(value => value === undefined)) throw new Error("Unable to locate required exports in @modelcontextprotocol/ext-apps/app-with-deps.");
    return `${source.slice(0, exportBlock.index)}globalThis.__portableDevshellMcpApps={App:${names.App},applyDocumentTheme:${names.applyDocumentTheme},applyHostFonts:${names.applyHostFonts},applyHostStyleVariables:${names.applyHostStyleVariables}};`;
}
