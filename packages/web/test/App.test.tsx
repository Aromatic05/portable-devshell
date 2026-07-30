import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/views/App.js";
import { WebStore } from "../src/state/WebStore.js";

const snapshot = { name: "demo", status: "ready", connectionState: "connected", daemonState: "running", ready: true, lastSeq: 1 };
function store() { return new WebStore({ close() {}, reconnect: async () => {}, service: { status: async () => ({ ok: true, instanceCount: 1 }) }, instance: { list: async () => [{ name: "demo", mcpEnabled: true, snapshot }] }, runtime: { snapshot: async () => ({ snapshot, lastSeq: 1 }), refresh: async () => ({ snapshot, lastSeq: 1 }), readLogs: async () => [], start: async () => snapshot, stop: async () => snapshot, subscribe: async () => ({ next: async () => new Promise(() => undefined), close() {} }) }, tool: { listApprovals: async () => [], getApproval: async () => ({}), decideApproval: async () => ({}) }, mcp: { listApprovals: async () => [], decideApproval: async () => ({}) } } as never); }
describe("responsive application shell", () => {
    it("supports the mobile bottom flow and desktop navigation flow", async () => { render(<App store={store()} />); expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument(); const instances = screen.getAllByRole("button", { name: "Instances" }); expect(instances).toHaveLength(2); fireEvent.click(instances[0]!); expect(await screen.findByText("demo")).toBeInTheDocument(); fireEvent.click(screen.getByText("demo")); expect(await screen.findByText("Back to instances")).toBeInTheDocument(); });
});
