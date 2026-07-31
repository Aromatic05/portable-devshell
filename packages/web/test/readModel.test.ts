import { describe, expect, it } from "vitest";
import { asInstanceName, type InstanceSnapshot } from "@portable-devshell/shared/browser";

import { openTodos, todoSummaries } from "../src/selectors/readModel.js";
import type { WebState } from "../src/state/WebStore.js";

const snapshot: InstanceSnapshot = {
    connectionState: "disconnected",
    daemonState: "failed",
    lastSeq: 4,
    name: asInstanceName("failed-instance"),
    ready: false,
    status: "failed",
};

it("aggregates read-only todos without assigning operational health", () => {
    const state: WebState = {
        contextMessages: {},
        toolCalls: {},
        approvals: { "failed-instance": [] }, connection: "online", instances: [{ mcpEnabled: true, name: "failed-instance", snapshot }], logs: {}, oauthApprovals: [], operations: {}, partialFailures: {}, todos: {
            "failed-instance": { items: [], revision: 7, summary: { completed: 1, total: 3 }, tasks: [{ completed: 1, revision: 7, status: "in_progress", taskId: "deploy", title: "Deploy service", total: 3, updatedAt: "2026-07-31T00:00:00Z" }] },
        },
    };

    expect(todoSummaries(state)).toEqual([{ completed: 1, instance: "failed-instance", revision: 7, status: "in_progress", taskId: "deploy", title: "Deploy service", total: 3 }]);
    expect(openTodos(state)).toBe(1);
});
