import type { TodoReadResult } from "@portable-devshell/shared";
import { expect, it } from "vitest";

import { todoSummaries } from "../../src/view/ReadModel.js";

const todo: TodoReadResult = {
    items: [],
    revision: 7,
    summary: { completed: 1, total: 3 },
    tasks: [
        {
            completed: 1,
            revision: 7,
            status: "in_progress",
            taskId: "deploy",
            title: "Deploy service",
            total: 3,
            updatedAt: "2026-07-31T00:00:00Z",
        },
    ],
};

it("aggregates read-only todos without assigning operational health", () => {
    expect(todoSummaries("failed-instance", todo)).toEqual([
        {
            completed: 1,
            instance: "failed-instance",
            revision: 7,
            status: "in_progress",
            taskId: "deploy",
            title: "Deploy service",
            total: 3,
        },
    ]);
    expect(todoSummaries("failed-instance", undefined)).toEqual([]);
});
