import { useEffect, useState } from "react";

export const webPages = [
    "overview",
    "instances",
    "messages",
    "audit",
    "approvals",
    "todos",
] as const;

export type WebPage = (typeof webPages)[number];

export type AuditScope =
    | { kind: "all" }
    | { kind: "instance"; instance: string }
    | { kind: "context"; instance: string; ctxId: string };

export type WebRoute =
    | { page: "overview" }
    | { page: "instances" }
    | { page: "messages"; view: "contexts" }
    | { page: "messages"; view: "thread"; instance: string; ctxId: string }
    | { page: "audit"; view: "timeline"; scope: AuditScope }
    | { page: "audit"; view: "call"; instance: string; ctxId?: string; callId: string }
    | { page: "approvals" }
    | { page: "todos" };

export function pageRoute(page: WebPage): WebRoute {
    switch (page) {
        case "messages":
            return { page, view: "contexts" };
        case "audit":
            return { page, view: "timeline", scope: { kind: "all" } };
        default:
            return { page };
    }
}

export function readHashRoute(hash = window.location.hash): WebRoute {
    const segments = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeSegment);
    const [page, first, second, third, fourth] = segments;
    if (page === "activity") return pageRoute("audit");
    if (page === "messages") {
        return first !== undefined && second !== undefined
            ? { page, view: "thread", instance: first, ctxId: second }
            : pageRoute(page);
    }
    if (page === "audit") {
        if (first === "context" && second !== undefined && third !== undefined) {
            if (segments[4] === "call" && segments[5] !== undefined) {
                return {
                    page,
                    view: "call",
                    instance: second,
                    ctxId: third,
                    callId: segments[5],
                };
            }
            return {
                page,
                view: "timeline",
                scope: { kind: "context", instance: second, ctxId: third },
            };
        }
        if (first === "instance" && second !== undefined) {
            if (third === "call" && fourth !== undefined) {
                return { page, view: "call", instance: second, callId: fourth };
            }
            return {
                page,
                view: "timeline",
                scope: { kind: "instance", instance: second },
            };
        }
        return pageRoute(page);
    }
    return webPages.includes(page as WebPage) && page !== "messages" && page !== "audit"
        ? pageRoute(page as Exclude<WebPage, "messages" | "audit">)
        : pageRoute("overview");
}

export function webRouteHref(route: WebRoute): string {
    switch (route.page) {
        case "messages":
            return route.view === "contexts"
                ? "#/messages"
                : `#/messages/${encodeSegment(route.instance)}/${encodeSegment(route.ctxId)}`;
        case "audit": {
            if (route.view === "call") {
                return route.ctxId === undefined
                    ? `#/audit/instance/${encodeSegment(route.instance)}/call/${encodeSegment(route.callId)}`
                    : `#/audit/context/${encodeSegment(route.instance)}/${encodeSegment(route.ctxId)}/call/${encodeSegment(route.callId)}`;
            }
            if (route.scope.kind === "instance") {
                return `#/audit/instance/${encodeSegment(route.scope.instance)}`;
            }
            if (route.scope.kind === "context") {
                return `#/audit/context/${encodeSegment(route.scope.instance)}/${encodeSegment(route.scope.ctxId)}`;
            }
            return "#/audit";
        }
        default:
            return `#/${route.page}`;
    }
}

export function navigate(route: WebRoute): void {
    const nextHash = webRouteHref(route);
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
}

export function useHashRoute(): [WebRoute, (route: WebRoute) => void] {
    const [route, setRoute] = useState(readHashRoute);

    useEffect(() => {
        const update = () => setRoute(readHashRoute());
        window.addEventListener("hashchange", update);
        window.addEventListener("popstate", update);
        return () => {
            window.removeEventListener("hashchange", update);
            window.removeEventListener("popstate", update);
        };
    }, []);

    return [route, (nextRoute) => {
        navigate(nextRoute);
        setRoute(nextRoute);
    }];
}

function encodeSegment(value: string): string {
    return encodeURIComponent(value);
}

function decodeSegment(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
