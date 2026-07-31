import type { TuiFocusScope } from "../TuiUiState.js";

export type TuiRoute =
    | { page: "overview"; view: "summary" }
    | { page: "instances"; view: "list" }
    | { page: "config"; view: "overview" }
    | { page: "connections"; view: "overview" }
    | { connectorId: string; page: "connections"; view: "connector" }
    | { page: "connections"; providerId: string; view: "oauth" }
    | { instanceId: string; page: "connections"; view: "reverse" }
    | { page: "audit"; view: "contexts" }
    | { ctxId: string; page: "audit"; view: "context" }
    | { callId: string; ctxId: string; page: "audit"; view: "call" }
    | { page: "todo"; view: "overview" }
    | { page: "todo"; todoId: string; view: "detail" }
    | { page: "logs"; view: "sources" }
    | { page: "logs"; sourceId: string; view: "stream" }
    | { page: "help"; view: "index" }
    | { page: "terminal"; view: "session" };

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
            return { page, view: "contexts" };
        case "logs":
            return { page, view: "sources" };
        case "help":
            return { page, view: "index" };
        case "terminal":
            return { page, view: "session" };
    }
}

export function tuiRouteIdentity(route: TuiRoute): string {
    switch (route.page) {
        case "overview":
        case "instances":
        case "config":
        case "help":
        case "terminal":
            return `${route.page}/${route.view}`;
        case "audit":
            if (route.view === "contexts") return "audit/contexts";
            if (route.view === "context") return `audit/context/${encodeURIComponent(route.ctxId)}`;
            return `audit/context/${encodeURIComponent(route.ctxId)}/call/${encodeURIComponent(route.callId)}`;
        case "todo":
            return route.view === "overview" ? "todo/overview" : `todo/detail/${encodeURIComponent(route.todoId)}`;
        case "logs":
            return route.view === "sources" ? "logs/sources" : `logs/stream/${encodeURIComponent(route.sourceId)}`;
        case "connections":
            if (route.view === "overview") return "connections/overview";
            if (route.view === "connector") return `connections/connector/${encodeURIComponent(route.connectorId)}`;
            if (route.view === "oauth") return `connections/oauth/${encodeURIComponent(route.providerId)}`;
            return `connections/reverse/${encodeURIComponent(route.instanceId)}`;
    }
}

export function defaultTuiRouteViewState(): TuiRouteViewState {
    return {
        expandedItemIds: [],
        focusRegion: "mainBoxes",
        scrollOffset: 0
    };
}
