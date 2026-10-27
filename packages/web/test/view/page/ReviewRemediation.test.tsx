import React, { useSyncExternalStore } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
    createDefaultControlConfig,
    toConfigView,
    normalizeConfigDraft,
    ConfigViewModel,
    ToolCallViewModel,
} from "../../../../shared/src/index.js";
import { ConfigBatchEditor } from "../../../../control/src/config/editor/Batch.js";
import { Connections } from "../../../src/view/page/Connections.js";
import { ToolCallEntry } from "../../../src/view/page/activity/audit/tool/Entry.js";
import { deferred } from "../../support/BetaMatrixHarness.js";
import type { ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";
import { WebStore } from "../../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";

afterEach(() => vi.useRealTimers());

it("replays remote commit within ConfigViewModel coalescing window: Connections Save preserves untouched remote public URL", async () => {
    vi.useFakeTimers();
    let current = createDefaultControlConfig();
    let revision = 0;
    const engine = {
        get current() {
            return current;
        },
        async runExclusive(action: () => Promise<unknown>) {
            return await action();
        },
        readInput(action: () => unknown) {
            return action();
        },
        requireDomain() {},
        async commit(_previous: unknown, next: typeof current) {
            current = next;
            revision++;
            return toConfigView(current);
        },
    };
    const batch = new ConfigBatchEditor(engine as never);
    let deliver!: (message: unknown) => void;
    const updates: unknown[] = [];
    const model = new ConfigViewModel({
        async snapshot() {
            return { revision, view: toConfigView(current) };
        },
        async subscribe() {
            return {
                next: () =>
                    new Promise((resolve) => {
                        deliver = resolve;
                    }),
                close() {},
            };
        },
        async validate(draft: never) {
            return toConfigView(normalizeConfigDraft(draft));
        },
        async update(request: never) {
            updates.push(request);
            return await batch.updateConfig(request);
        },
    } as never);
    try {
        await model.get();
        await Promise.resolve();
        await Promise.resolve();
        const domains = new WebTestDomains();
        Object.assign(domains.domains, { config: model });
        const store = new WebStore(domains.domains);
        render(
            withWebDomains(
                domains,
                <Connections disabled={false} store={store} />,
            ),
        );
        const card = screen.getByRole("heading", {
            name: "[Global] MCP listener",
        }).parentElement!;
        // Select by visible label, preserving all other loaded endpoint fields.
        const labels = [...card.querySelectorAll("label")];
        const portField = labels
            .find((label) => label.textContent?.includes("Listen port"))!
            .querySelector("input")!;
        fireEvent.change(portField, { target: { value: "3200" } });
        const oldUrl = current.mcp.publicBaseUrl;
        await batch.updateConfig({
            mcp: { publicBaseUrl: "https://new.example" },
        });
        await act(async () => {
            deliver({
                kind: "event",
                event: { revision, paths: ["mcp.publicBaseUrl"] },
            });
            await Promise.resolve();
        });
        expect(current.mcp.publicBaseUrl).toBe("https://new.example");
        expect(model.state.view?.mcp.publicBaseUrl).toBe(oldUrl);
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        expect(store.state.error).toBeUndefined();
        expect(updates).toEqual([{ mcp: { listenPort: 3200 } }]);
        expect(current.mcp.listenPort).toBe(3200);
        expect(current.mcp.publicBaseUrl).toBe("https://new.example");
        expect(screen.queryByText(/settings changed on the server/)).toBeNull();
    } finally {
        model.close();
    }
});

it("replays an archived Context detail failure: card Refresh retries its own detail", async () => {
    const records = Array.from({ length: 230 }, (_, i) => ({
        callId: "call-" + i,
        instance: "alpha",
        ctxId: "ctx-a",
        toolName: i === 0 ? "old_archived_tool" : "other_tool",
        inputSummary: "{}",
        source: "mcp",
        status: "completed",
        startedAt: new Date(1700000000000 + i * 1000).toISOString(),
    }));
    let failDetail = true;
    let detailReads = 0;
    const retry = deferred<void>();
    const model = new ToolCallViewModel({
        cursor: async () => 0,
        transport: () =>
            ({
                async listCalls(query: ToolCallQuery = {}) {
                    if (query.callIds) {
                        detailReads++;
                        if (failDetail)
                            throw new Error(
                                "Transient archived detail failure",
                            );
                        if (detailReads === 2) await retry.promise;
                        return [
                            {
                                ...records[0],
                                input: { command: "old" },
                                output: { stdout: "Recovered archived output" },
                            },
                        ];
                    }
                    const end = query.before
                        ? records.findIndex(
                              (call) => call.callId === query.before,
                          )
                        : records.length;
                    return structuredClone(
                        records.slice(0, end).slice(-(query.limit ?? 200)),
                    );
                },
                async subscribe() {
                    return {
                        next: async () => await new Promise(() => {}),
                        close() {},
                    };
                },
            }) as never,
    });
    try {
        await model.loadContext("alpha", "ctx-a");
        await model.loadOlderContext("alpha", "ctx-a");
        const retained = model.state.context!.calls.find(
            (call) => call.callId === "call-0",
        );
        const domains = new WebTestDomains();
        Object.assign(domains.domains, { toolCalls: model });
        const store = new WebStore(domains.domains);
        function Card() {
            const state = useSyncExternalStore(
                (listener) => model.subscribe(listener),
                () => model.state,
            );
            const call = state.context!.calls.find(
                (call) => call.callId === "call-0",
            )!;
            return (
                <ol>
                    <ToolCallEntry
                        call={call}
                        initiallyOpen
                        logs={[]}
                        onLoadImage={vi.fn()}
                        onReviewApproval={vi.fn()}
                        onLoadDetail={async () =>
                            (await model.readDetail("alpha", "call-0"))[0]
                        }
                        onRefresh={async () => {
                            await store.refreshToolCall("alpha");
                        }}
                    />
                </ol>
            );
        }
        render(<Card />);
        await screen.findByText("Transient archived detail failure");
        failDetail = false;
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await screen.findByText("Loading details…");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(model.state.context!.ctxId).toBe("ctx-a");
        await act(async () => retry.resolve());
        expect(
            model.state.context!.calls.find((call) => call.callId === "call-0"),
        ).toBe(retained);
        await screen.findByText(/Recovered archived output/);
        expect(detailReads).toBe(2);
        expect(screen.queryByRole("alert")).toBeNull();
        // Counter-proof: close/reopen does recover via the same authoritative detail producer.
        fireEvent.click(screen.getByText("old_archived_tool"));
        fireEvent.click(screen.getByText("old_archived_tool"));
        await screen.findByText(/Recovered archived output/);
        expect(detailReads).toBe(3);
    } finally {
        model.close();
    }
});

it.each(["resolve", "reject"])(
    "ignores stale detail retry %s after switching cards",
    async (completion) => {
        const call = {
            callId: "old",
            instance: "alpha",
            ctxId: "ctx-old",
            toolName: "archived",
            inputSummary: "{}",
            source: "mcp",
            status: "completed",
            startedAt: new Date(0).toISOString(),
        } as ToolCallRecord;
        const retry = deferred<ToolCallRecord | undefined>();
        const read = vi
            .fn()
            .mockRejectedValueOnce(new Error("First detail failed"))
            .mockReturnValueOnce(retry.promise);
        const props = {
            initiallyOpen: true,
            logs: [],
            onLoadImage: vi.fn(),
            onReviewApproval: vi.fn(),
            onRefresh: vi.fn().mockResolvedValue(undefined),
        };
        const card = render(
            <ol>
                <ToolCallEntry {...props} call={call} onLoadDetail={read} />
            </ol>,
        );
        await screen.findByText("First detail failed");
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await screen.findByText("Loading details…");
        expect(read).toHaveBeenCalledTimes(2);
        card.rerender(
            <ol>
                <ToolCallEntry
                    {...props}
                    call={{
                        ...call,
                        callId: "new",
                        ctxId: "ctx-new",
                        input: {},
                        output: "New detail",
                    }}
                    onLoadDetail={vi.fn()}
                />
            </ol>,
        );
        await screen.findByText("New detail");
        await act(async () => {
            if (completion === "resolve")
                retry.resolve({ ...call, input: {}, output: "Stale detail" });
            else retry.reject(new Error("Stale failure"));
        });
        expect(screen.queryByText("Stale detail")).toBeNull();
        expect(screen.queryByText("Stale failure")).toBeNull();
        expect(screen.getByText("New detail")).toBeInTheDocument();
    },
);
