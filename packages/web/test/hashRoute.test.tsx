import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHashRoute } from "../src/routing/hashRoute.js";

function RouteProbe() {
    const [route, navigate] = useHashRoute();
    return <><output>{route}</output><button onClick={() => navigate("todos")}>Todos</button></>;
}

describe("hash routing", () => {
    it("keeps a bookmarkable route and responds to back and forward hash changes", () => {
        window.location.hash = "#/instances";
        render(<RouteProbe />);
        expect(screen.getByText("instances")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Todos" }));
        expect(window.location.hash).toBe("#/todos");
        expect(screen.getByText("todos")).toBeInTheDocument();

        window.location.hash = "#/approvals";
        fireEvent(window, new HashChangeEvent("hashchange"));
        expect(screen.getByText("approvals")).toBeInTheDocument();
        window.location.hash = "#/instances";
        fireEvent(window, new PopStateEvent("popstate"));
        expect(screen.getByText("instances")).toBeInTheDocument();
    });
});
