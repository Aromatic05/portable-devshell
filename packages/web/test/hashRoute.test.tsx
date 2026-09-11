import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
    pageRoute,
    readHashRoute,
    useHashRoute,
    webRouteHref,
    type WebRoute,
} from "../src/routing/hashRoute.js";

function RouteProbe() {
    const [route, navigate] = useHashRoute();
    return <>
        <output>{webRouteHref(route)}</output>
        <button onClick={() => navigate(pageRoute("todos"))}>Todos</button>
    </>;
}

describe("hash routing", () => {
    it("round-trips Messages and Audit hierarchy through bookmarkable URLs", () => {
        const routes: WebRoute[] = [
            { page: "messages", view: "contexts" },
            { page: "messages", view: "thread", instance: "dev/main", ctxId: "ctx alpha" },
            { page: "audit", view: "timeline", scope: { kind: "all" } },
            { page: "audit", view: "timeline", scope: { kind: "instance", instance: "dev/main" } },
            { page: "audit", view: "timeline", scope: { kind: "context", instance: "dev/main", ctxId: "ctx alpha" } },
            { page: "audit", view: "call", instance: "dev/main", ctxId: "ctx alpha", callId: "call/1" },
            { page: "audit", view: "call", instance: "dev/main", callId: "call/2" },
        ];

        for (const route of routes) expect(readHashRoute(webRouteHref(route))).toEqual(route);
    });

    it("maps the legacy activity URL onto Audit without keeping activity as a page", () => {
        expect(readHashRoute("#/activity")).toEqual(pageRoute("audit"));
    });

    it("keeps a bookmarkable route and responds to back and forward hash changes", () => {
        window.location.hash = "#/instances";
        render(<RouteProbe />);
        expect(screen.getByText("#/instances")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Todos" }));
        expect(window.location.hash).toBe("#/todos");
        expect(screen.getByText("#/todos")).toBeInTheDocument();

        window.location.hash = "#/audit/context/demo/ctx-a";
        fireEvent(window, new HashChangeEvent("hashchange"));
        expect(screen.getByText("#/audit/context/demo/ctx-a")).toBeInTheDocument();
        window.location.hash = "#/messages/demo/ctx-a";
        fireEvent(window, new PopStateEvent("popstate"));
        expect(screen.getByText("#/messages/demo/ctx-a")).toBeInTheDocument();
    });
});
