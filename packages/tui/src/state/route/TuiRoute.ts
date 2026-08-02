import type { TuiFocusScope } from "../TuiUiState.js";

export type TuiTerminalTab = "instances" | "tmuxPanes";

export type TuiRoute =
    | { page: "overview"; view: "summary" }
    | { page: "instances"; view: "list" }
    | { page: "config"; view: "overview" }
    | { page: "connections"; view: "overview" }
    | { connectorId: string; page: "connections"; view: "connector" }
    | { page: "connections"; providerId: string; view: "oauth" }
    | { instanceId: string; page: "connections"; view: "reverse" }
    | { page: "audit"; view: "contexts" }
    | { page: "audit"; scope: "unscoped"; view: "context" }
    | { ctxId: string; page: "audit"; scope: "context"; view: "context" }
    | { ctxId: string; page: "audit"; scope: "context"; view: "conversation" }
    | { callId: string; page: "audit"; scope: "unscoped"; view: "call" }
    | { page: "todo"; view: "overview" }
    | { page: "todo"; todoId: string; view: "detail" }
    | { page: "logs"; view: "contexts" }
    | { page: "logs"; scope: "unscoped"; view: "context" }
    | { ctxId: string; page: "logs"; scope: "context"; view: "context" }
    | { page: "help"; view: "index" }
    | { page: "terminal"; pane?: string; tab: TuiTerminalTab; view: "session" };

export interface TuiRouteViewState {
    readonly expandedItemIds: readonly string[];
    readonly focusRegion: TuiFocusScope;
    readonly scrollOffset: number;
    readonly selectedItemId?: string;
}

export function rootTuiRoute(page: TuiRoute["page"]): TuiRoute {
    switch (page) {
        case "overview":
            return { page, view: "summary" };
        case "instances":
            return { page, view: "list" };
        case "config":
        case "connections":
        case "todo":
            return { page, view: "overview" };
        case "audit":
        case "logs":
            return { page, view: "contexts" };
        case "help":
            return { page, view: "index" };
        case "terminal":
            return { page, tab: "instances", view: "session" };
    }
}

export function tuiRouteIdentity(route: TuiRoute): string {
    switch (route.page) {
        case "overview":
        case "instances":
        case "config":
        case "help":
            return `${route.page}/${route.view}`;
        case "terminal":
            return route.pane === undefined
                ? `terminal/${route.tab}`
                : `terminal/${route.tab}/${encodeURIComponent(route.pane)}`;
        case "audit":
            if (route.view === "contexts") return "audit/contexts";
            if (route.scope === "unscoped") {
                return route.view === "context"
                    ? "audit/context/unscoped"
                    : `audit/context/unscoped/call/${encodeURIComponent(route.callId)}`;
            }
            if (route.view === "context") {
                return `audit/context/${encodeURIComponent(route.ctxId)}`;
            }
            if (route.view === "conversation") {
                return `audit/context/${encodeURIComponent(route.ctxId)}/conversation`;
            }
            throw new Error("Unsupported audit route.");
        case "todo":
            return route.view === "overview"
                ? "todo/overview"
                : `todo/detail/${encodeURIComponent(route.todoId)}`;
        case "logs":
            if (route.view === "contexts") return "logs/contexts";
            return route.scope === "unscoped"
                ? "logs/context/unscoped"
                : `logs/context/${encodeURIComponent(route.ctxId)}`;
        case "connections":
            if (route.view === "overview") return "connections/overview";
            if (route.view === "connector") {
                return `connections/connector/${encodeURIComponent(route.connectorId)}`;
            }
            if (route.view === "oauth") {
                return `connections/oauth/${encodeURIComponent(route.providerId)}`;
            }
            return `connections/reverse/${encodeURIComponent(route.instanceId)}`;
    }
}

export function defaultTuiRouteViewState(): TuiRouteViewState {
    return {
        expandedItemIds: [],
        focusRegion: "mainBoxes",
        scrollOffset: 0,
    };
}
