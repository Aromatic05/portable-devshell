import { controlWebBasePath, type ConfigView, type JsonValue } from "@portable-devshell/shared";

export interface AgentWebView {
    webUrl: string | null;
}

export function agentWebView(config: Record<string, JsonValue>): AgentWebView {
    const web = (config as unknown as ConfigView).web;
    if (!web.enabled) return { webUrl: null };
    const url = new URL(web.publicBaseUrl);
    url.pathname = `${controlWebBasePath(web.publicBaseUrl)}/agent/`;
    url.search = "";
    url.hash = "";
    return { webUrl: url.toString() };
}
