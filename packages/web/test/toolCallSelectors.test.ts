import { describe, expect, it } from "vitest";
import {
    asInstanceName,
    type ToolCallRecord,
} from "@portable-devshell/shared/browser";

import {
    formatToolValue,
    resolveToolCallOutput,
} from "../src/formatters/toolCalls.js";
import {
    emptyToolCallFilters,
    filterToolCalls,
    selectToolCalls,
    toolCallResult,
} from "../src/selectors/toolCalls.js";

const calls: ToolCallRecord[] = [
    {
        callId: "call-old",
        completedAt: "2026-07-31T08:30:01Z",
        ctxId: "ctx-alpha",
        inputSummary: '{"path":"README.md"}',
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-07-31T08:30:00Z",
        status: "completed",
        toolName: "file_read",
        workspace: "/projects/docs",
    },
    {
        callId: "call-failed",
        completedAt: "2026-07-31T09:30:01Z",
        ctxId: "ctx-alpha",
        error: "command failed",
        inputSummary: '{"command":"false"}',
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-07-31T09:30:00Z",
        status: "failed",
        toolName: "bash_run",
        workspace: "/projects/alpha",
    },
    {
        callId: "call-pending",
        inputSummary: "{}",
        instance: asInstanceName("beta"),
        source: "tui",
        startedAt: "2026-07-31T09:45:00Z",
        status: "pendingApproval",
        toolName: "artifact_transfer",
        workspace: "/projects/beta",
    },
];

describe("tool call audit query", () => {
    it("applies text, workspace, result, tool, and time filters together", () => {
        expect(
            filterToolCalls(
                calls,
                {
                    period: "1h",
                    query: "command failed",
                    result: "failure",
                    tool: "bash_run",
                    workspace: "projects/alpha",
                },
                Date.parse("2026-07-31T10:00:00Z"),
            ),
        ).toEqual([calls[1]]);
    });

    it("formats complete structured input and restores output from linked logs", () => {
        expect(
            formatToolValue({ command: "printf ok", options: { timeoutMs: 1000 } }),
        ).toBe("\n  command: printf ok\n  options:\n    timeoutMs: 1000");
        expect(
            resolveToolCallOutput(calls[0]!, [
                {
                    at: "2026-07-31T08:30:01Z",
                    callId: "call-old",
                    instanceName: "alpha",
                    message: "hello",
                    seq: 1,
                    stream: "stdout",
                },
            ]),
        ).toEqual({ stdout: "hello" });
    });

    it("classifies tool call statuses for quick result filters", () => {
        expect(toolCallResult(calls[0]!)).toBe("success");
        expect(toolCallResult(calls[1]!)).toBe("failure");
        expect(toolCallResult(calls[2]!)).toBe("pending");
    });
});

describe("bounded Tool Call presentation", () => {
    it("searches actual structured input and output", () => {
        const call = {
            ...calls[0]!,
            callId: "structured-search",
            input: { command: "unique-input-token" },
            output: { stdout: "unique-output-token" },
        };
        expect(filterToolCalls([call], { ...emptyToolCallFilters, query: "unique-input-token" })).toEqual([call]);
        expect(filterToolCalls([call], { ...emptyToolCallFilters, query: "unique-output-token" })).toEqual([call]);
    });

    it("bounds deeply nested and oversized values", () => {
        let nested: unknown = "leaf";
        for (let index = 0; index < 15_000; index += 1) nested = { nested };
        const deep = formatToolValue(nested as never);
        const large = formatToolValue("x".repeat(2_000_000));

        expect(deep).toContain("truncated");
        expect(large.length).toBeLessThanOrEqual(210_000);
        expect(large).toContain("truncated");
    });
});

it("uses a global traversal budget for wide nested values", () => {
    let reads = 0;
    const inner = new Proxy(new Array(1_000).fill("value"), {
        get(target, property, receiver) {
            if (typeof property === "string" && /^\d+$/u.test(property)) reads += 1;
            return Reflect.get(target, property, receiver);
        },
    });
    const root = new Array(1_000).fill(inner);

    const formatted = formatToolValue(root as never);

    expect(formatted).toContain("truncated");
    expect(reads).toBeLessThan(2_000);
});

it("reports the full match count separately from the display limit", () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
        ...calls[0]!,
        callId: `call-${index}`,
        startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const { items, total } = selectToolCalls(many, emptyToolCallFilters);

    expect(items).toHaveLength(100);
    expect(total).toBe(150);
});

it("returns the requested page of matching calls", () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
        ...calls[0]!,
        callId: `call-${index}`,
        startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
    }));
    const { items, total } = selectToolCalls(many, emptyToolCallFilters, Date.now(), 100);

    expect(items).toHaveLength(50);
    expect(total).toBe(150);
});
