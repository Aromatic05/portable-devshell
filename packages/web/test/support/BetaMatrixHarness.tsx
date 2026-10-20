import { render } from "@testing-library/react";
import { asInstanceName, type ToolCallRecord } from "@portable-devshell/shared";
import { Config } from "../../src/view/page/Config.js";
import { Todos } from "../../src/view/page/Todos.js";
import { Audit } from "../../src/view/page/activity/audit/Page.js";
import { WebStore } from "../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "./DomainHarness.js";

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export function configView() {
    return {
        control: {}, mcp: {}, web: {}, restartControlRequired: false,
        instances: ["alpha", "beta"].map((name) => ({
            name, provider: "local", enabled: true,
            logs: { retentionDays: name === "alpha" ? 7 : 14 },
            workspace: { enabled: true },
        })),
    };
}

export function setupConfig() {
    const domains = new WebTestDomains();
    domains.setConfig(configView());
    domains.setInstances(["alpha", "beta"].map((name) => ({
        name, mcpEnabled: true,
        snapshot: { name: asInstanceName(name), daemonState: "running", ready: true },
    })));
    const store = new WebStore(domains.domains);
    const view = (instance: string) => withWebDomains(domains,
        <Config disabled={false} instance={instance} store={store} />);
    return { domains, store, view, ...render(view("alpha")) };
}

export function todo(taskId: string, revision: number, title = taskId) {
    return { taskId, revision, title,
        items: [{ id: "step", content: "Inspect", status: "in_progress" }],
        summary: { completed: 0, currentItemId: "step", total: 1 } };
}

export function setupTodos() {
    const domains = new WebTestDomains();
    Object.assign(domains.goals, { load: async () => undefined });
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    domains.setTodo("alpha", todo("same-task", 3, "Alpha project"));
    domains.setTodo("beta", todo("same-task", 9, "Beta project"));
    const store = new WebStore(domains.domains);
    return { domains, store, ...render(withWebDomains(domains, <Todos store={store} />)) };
}

export const auditCall = {
    callId: "same-call", ctxId: "old-context", instance: asInstanceName("alpha"),
    source: "mcp" as const, toolName: "bash_run", status: "running" as const,
    startedAt: "2026-10-20T01:00:00Z", workspace: "/project/alpha",
    input: { command: "deploy" }, inputSummary: '{"command":"deploy"}',
} satisfies ToolCallRecord;

export function setupAudit() {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha", mcpEnabled: true }]);
    domains.setToolCalls("alpha", [auditCall]);
    domains.setApprovals("alpha", [{
        approvalId: "approval-alpha", callId: auditCall.callId,
        instance: asInstanceName("alpha"), toolName: "bash_run", reason: "Review deploy",
        inputSummary: '{"command":"deploy"}', ctxId: "old-context",
        status: "pending", source: "mcp", riskLevel: "high",
        createdAt: "2026-10-20T01:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
    }]);
    const store = new WebStore(domains.domains);
    const view = withWebDomains(domains, <Audit navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: {
            kind: "context", instance: "alpha", ctxId: "old-context",
        } }} store={store} />);
    return { domains, store, view, ...render(view) };
}
