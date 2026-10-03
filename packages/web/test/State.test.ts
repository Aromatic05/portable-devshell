import { afterEach, describe, expect, it, vi } from "vitest";
import {
    asInstanceName,
    createEmptyConversationPreferences,
    type ContextMessageRecord,
    type InstanceCreateDraft,
    type InstanceSnapshot,
    type McpContextRecord,
    type ProcessStartOptions,
} from "@portable-devshell/shared";

import { WebStore } from "../src/state/Store.js";
import { WebTestDomains } from "./support/DomainHarness.js";

const snapshot: InstanceSnapshot = {
    connectionState: "connected",
    daemonState: "running",
    lastSeq: 3,
    name: asInstanceName("demo"),
    ready: true,
    status: "ready",
};

afterEach(() => {
    vi.useRealTimers();
});

describe("WebStore", () => {
    it("waits for the domain session before completing its load", async () => {
        const domains = new WebTestDomains();
        let resolveLoad!: () => void;
        domains.domains.load = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveLoad = resolve;
                }),
        );
        const store = new WebStore(domains.domains);

        let settled = false;
        const loading = store.load().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(domains.domains.load).toHaveBeenCalledOnce();
        expect(settled).toBe(false);

        resolveLoad();
        await loading;
        expect(settled).toBe(true);
        expect(store.state.error).toBeUndefined();
    });

    it("updates server-backed Conversation preferences", async () => {
        const domains = new WebTestDomains();
        const server = {
            hiddenContexts: {},
            orderByWorkspace: { "/work/demo": ["demo\u0000ctx-a"] },
            titles: { "demo\u0000ctx-a": "Server title" },
            version: 1 as const,
            workspaceOrder: ["/work/demo"],
        };
        domains.conversationPreferences.patch({ preferences: server });
        const updatePreferences = vi.spyOn(
            domains.domains.conversationPreferences,
            "update",
        );
        const store = new WebStore(domains.domains);

        await store.load();
        expect(
            domains.domains.conversationPreferences.state.preferences.titles[
                "demo\u0000ctx-a"
            ],
        ).toBe("Server title");
        expect(
            await store.updateConversationPreferences({
                titles: { "demo\u0000ctx-b": "Second browser" },
            }),
        ).toBe(true);
        expect(updatePreferences).toHaveBeenCalledWith({
            titles: { "demo\u0000ctx-b": "Second browser" },
        });
        expect(
            domains.domains.conversationPreferences.state.preferences.titles[
                "demo\u0000ctx-b"
            ],
        ).toBe("Second browser");
    });

    it("does not replay queued Conversation preference mutations after the store generation changes", async () => {
        const domains = new WebTestDomains();
        const preferences = createEmptyConversationPreferences();
        let releaseFirst!: () => void;
        const updatePreferences = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<typeof preferences>((resolve) => {
                        releaseFirst = () => resolve(preferences);
                    }),
            )
            .mockResolvedValue(preferences);
        domains.domains.conversationPreferences.update = updatePreferences;
        const store = new WebStore(domains.domains);
        await store.load();

        const first = store.updateConversationPreferences({
            titles: { "demo\u0000ctx-a": "A" },
        });
        const second = store.updateConversationPreferences({
            titles: { "demo\u0000ctx-b": "B" },
        });
        await Promise.resolve();
        expect(updatePreferences).toHaveBeenCalledTimes(1);

        store.close();
        releaseFirst();
        expect(await first).toBe(false);
        expect(await second).toBe(false);
        expect(updatePreferences).toHaveBeenCalledTimes(1);
    });

    it("keeps the service online while exposing a Conversation preference load failure", async () => {
        const domains = new WebTestDomains();
        domains.domains.load = vi.fn(async () => {
            domains.conversationPreferences.patch({
                failure: new Error("Preference store unavailable"),
            });
        });
        const store = new WebStore(domains.domains);

        await store.load();

        expect(domains.service.state.status).toBe("online");
        expect(domains.conversationPreferences.state.failure?.message).toBe(
            "Preference store unavailable",
        );
        expect(store.state.error).toBeUndefined();
    });

    it("does not read MCP approvals while loading the store", async () => {
        const domains = new WebTestDomains();
        const refresh = vi.spyOn(domains.domains.mcp, "refresh");

        await new WebStore(domains.domains).load();

        expect(refresh).not.toHaveBeenCalled();
    });

    it("loads Audit data lazily and queues Context messages through the message domain", async () => {
        const domains = new WebTestDomains();
        const call = {
            callId: "call-1",
            ctxId: "ctx-demo",
            inputSummary: "{}",
            instance: asInstanceName("demo"),
            source: "mcp" as const,
            startedAt: "2026-07-31T00:00:00Z",
            status: "running" as const,
            toolName: "bash_run",
        };
        const queued: ContextMessageRecord = {
            createdAt: "2026-07-31T00:00:01Z",
            ctxId: "ctx-demo",
            id: "message-1",
            instance: "demo",
            status: "pending",
            text: "Continue with the next check.",
        };
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        const loadToolCalls = vi.fn(async (_instance: string) => {
            domains.setToolCalls("demo", [call]);
        });
        const queue = vi.fn(
            async (
                _instance: string,
                _ctxId: string,
                _text: string,
            ): Promise<ContextMessageRecord> => queued,
        );
        domains.domains.toolCalls.load = loadToolCalls;
        domains.domains.messages.queue = queue;
        const conversationRefresh = vi.spyOn(
            domains.domains.conversation,
            "refreshInstance",
        );
        const messagesRefresh = vi.spyOn(
            domains.domains.messages,
            "refreshInstance",
        );
        const contextRefresh = vi.spyOn(domains.domains.context, "refresh");
        const runtimeLoad = vi.spyOn(domains.domains.runtime("demo"), "load");
        const store = new WebStore(domains.domains);

        await store.load();
        expect(loadToolCalls).not.toHaveBeenCalled();
        expect(conversationRefresh).not.toHaveBeenCalled();
        expect(runtimeLoad).not.toHaveBeenCalled();

        await store.refreshAudit();

        expect(loadToolCalls).toHaveBeenCalledWith("demo");
        expect(domains.toolCalls.state.instances.demo?.calls).toEqual([call]);
        expect(conversationRefresh).toHaveBeenCalledWith("demo");
        expect(messagesRefresh).toHaveBeenCalledWith("demo");
        expect(contextRefresh).toHaveBeenCalledOnce();

        expect(
            await store.queueContextMessage("demo", "ctx-demo", queued.text),
        ).toBe(true);
        expect(queue).toHaveBeenCalledWith("demo", "ctx-demo", queued.text);
    });

    it("refreshes Messages without materializing Audit logs or Tool Calls", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        const conversationLoad = vi.fn(
            async (_instances: readonly string[]) => undefined,
        );
        const messagesLoad = vi.fn(
            async (_instances: readonly string[]) => undefined,
        );
        domains.domains.conversation.load = conversationLoad;
        domains.domains.messages.load = messagesLoad;
        const readLogs = vi.spyOn(domains.domains.runtime("demo"), "readLogs");
        const loadToolCalls = vi.spyOn(domains.domains.toolCalls, "load");
        const store = new WebStore(domains.domains);

        await store.load();
        await store.refreshMessages();

        expect(conversationLoad).toHaveBeenCalledWith(["demo"]);
        expect(messagesLoad).toHaveBeenCalledWith(["demo"]);
        expect(readLogs).not.toHaveBeenCalled();
        expect(loadToolCalls).not.toHaveBeenCalled();
    });

    it("revokes and cancels artifacts through the artifact domain", async () => {
        const domains = new WebTestDomains();
        const share = {
            blake3: "share-blake3",
            bytes: 1024,
            downloadName: "report.pdf",
            expiresAtMs: Date.now() + 60_000,
            mediaType: "application/pdf",
            shareId: "share-1",
            source: {
                instance: "demo",
                path: "report.pdf",
                workspace: "/workspace",
            },
            state: "active" as const,
            url: "https://example.test/share-1",
        };
        const transfer = {
            createdAt: "2026-09-16T00:00:00.000Z",
            source: {
                instance: "demo",
                path: "build.tar",
                workspace: "/workspace",
            },
            status: "transferring" as const,
            target: {
                instance: "remote",
                path: "build.tar",
                workspace: "/remote",
            },
            totalBytes: 4096,
            transferId: "transfer-1",
            transferredBytes: 1024,
            updatedAt: "2026-09-16T00:00:01.000Z",
        };
        domains.setArtifacts({ shares: [share], transfers: [transfer] });
        const revokeShare = vi.fn(async (_shareId: string) => undefined);
        const cancelTransfer = vi.fn(async (_transferId: string) => undefined);
        domains.domains.artifact.revokeShare = revokeShare;
        domains.domains.artifact.cancelTransfer = cancelTransfer;
        const store = new WebStore(domains.domains);

        await store.load();

        expect(domains.artifact.state.shares).toEqual([share]);
        expect(domains.artifact.state.transfers).toEqual([transfer]);

        await expect(store.revokeArtifactShare("share-1")).resolves.toBe(true);
        expect(revokeShare).toHaveBeenCalledWith("share-1");

        await expect(store.cancelArtifactTransfer("transfer-1")).resolves.toBe(
            true,
        );
        expect(cancelTransfer).toHaveBeenCalledWith("transfer-1");
    });

    it("surfaces recorded Tool Call or log failures from a manual Tool Call refresh", async () => {
        const domains = new WebTestDomains();
        const store = new WebStore(domains.domains);
        await store.load();
        domains.domains.toolCalls.load = vi.fn(async (_instance: string) => {
            throw new Error("tool calls refresh failed");
        });
        const readLogs = vi.spyOn(domains.domains.runtime("demo"), "readLogs");

        await expect(store.refreshToolCall("demo")).rejects.toThrow(
            "tool calls refresh failed",
        );
        expect(readLogs).toHaveBeenCalled();
    });

    it("refreshes every Audit read surface", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        const contextRefresh = vi.spyOn(domains.domains.context, "refresh");
        const loadToolCalls = vi.spyOn(domains.domains.toolCalls, "load");
        const conversationRefresh = vi.spyOn(
            domains.domains.conversation,
            "refreshInstance",
        );
        const messagesRefresh = vi.spyOn(
            domains.domains.messages,
            "refreshInstance",
        );
        const runtimeLoad = vi.spyOn(domains.domains.runtime("demo"), "load");
        const readLogs = vi.spyOn(domains.domains.runtime("demo"), "readLogs");
        const approvalLoad = vi.spyOn(domains.domains.approval("demo"), "load");
        const store = new WebStore(domains.domains);
        await store.load();

        await store.refreshAudit();

        expect(contextRefresh).toHaveBeenCalledOnce();
        expect(loadToolCalls).toHaveBeenCalledWith("demo");
        expect(conversationRefresh).toHaveBeenCalledWith("demo");
        expect(messagesRefresh).toHaveBeenCalledWith("demo");
        expect(runtimeLoad).toHaveBeenCalledWith("demo");
        expect(readLogs).toHaveBeenCalledOnce();
        expect(approvalLoad).toHaveBeenCalledWith("demo");
    });

    it("attempts every Context in a batch disable and reports the failure", async () => {
        const domains = new WebTestDomains();
        const disable = vi.fn(
            async (ctxId: string): Promise<McpContextRecord> => {
                if (ctxId === "ctx-b") throw new Error("ctx-b refused");
                return { ctxId } as McpContextRecord;
            },
        );
        domains.domains.context.disable = disable;
        const store = new WebStore(domains.domains);
        await store.load();

        expect(await store.disableContexts(["ctx-a", "ctx-b", "ctx-c"])).toBe(
            false,
        );
        expect(disable).toHaveBeenCalledTimes(3);
        expect(disable).toHaveBeenNthCalledWith(1, "ctx-a");
        expect(disable).toHaveBeenNthCalledWith(2, "ctx-b");
        expect(disable).toHaveBeenNthCalledWith(3, "ctx-c");
        expect(store.state.error).toContain("ctx-b");
    });

    it("reconnects the domain session and clears previous feedback", async () => {
        const domains = new WebTestDomains();
        domains.service.patch({ status: "offline" });
        const reconnect = vi.fn(async () => {
            domains.service.patch({ status: "online" });
        });
        domains.domains.reconnect = reconnect;
        const store = new WebStore(domains.domains);

        await store.load();
        await store.reconnect();

        expect(reconnect).toHaveBeenCalledOnce();
        expect(store.state.error).toBeUndefined();
        expect(domains.service.state.status).toBe("online");
    });

    it("does not let an old mutation clear a new connection operation", async () => {
        const domains = new WebTestDomains();
        const runtime = domains.domains.runtime("demo");
        runtime.load = vi.fn(async (_instance: string) => undefined);
        const oldStop = deferred<InstanceSnapshot>();
        const newStop = deferred<InstanceSnapshot>();
        runtime.stop = vi
            .fn()
            .mockImplementationOnce(() => oldStop.promise)
            .mockImplementationOnce(() => newStop.promise);
        const store = new WebStore(domains.domains);
        await store.load();

        const oldOperation = store.stop("demo");
        await store.reconnect();
        const newOperation = store.stop("demo");
        oldStop.resolve(snapshot);
        await oldOperation;

        expect(store.state.operations["stop:demo"]).toBe("pending");
        expect(store.state.notice).toBeUndefined();
        expect(store.state.error).toBeUndefined();
        newStop.resolve(snapshot);
        await newOperation;
        expect(store.state.operations["stop:demo"]).toBeUndefined();
        store.close();
    });

    it("does not send duplicate start or stop mutations while an operation is pending", async () => {
        const domains = new WebTestDomains();
        const runtime = domains.domains.runtime("demo");
        runtime.load = vi.fn(async (_instance: string) => undefined);
        const finish = deferred<InstanceSnapshot>();
        const stop = vi.fn(() => finish.promise);
        runtime.stop = stop;
        const store = new WebStore(domains.domains);
        await store.load();

        const first = store.stop("demo");
        const second = store.stop("demo");
        await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        expect(store.state.operations["stop:demo"]).toBe("pending");
        finish.resolve(snapshot);
        await Promise.all([first, second]);
        expect(store.state.operations["stop:demo"]).toBeUndefined();
    });

    it("applies a lifecycle snapshot through the instance runtime", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        const runtime = domains.domains.runtime("demo");
        runtime.load = vi.fn(async (_instance: string) => undefined);
        const stopped: InstanceSnapshot = {
            ...snapshot,
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: 10,
            ready: false,
            status: "stopped",
        };
        const stop = vi.fn(async () => {
            domains.setRuntime("demo", { snapshot: stopped });
            return stopped;
        });
        runtime.stop = stop;
        const store = new WebStore(domains.domains);
        await store.load();

        expect(domains.instances.state.instances[0]?.snapshot.status).toBe(
            "ready",
        );
        await store.stop("demo");

        expect(stop).toHaveBeenCalledOnce();
        expect(domains.runtime("demo").state.snapshot?.status).toBe("stopped");
        expect(store.state.notice).toBe("demo stop requested.");
        store.close();
    });

    it("creates reverse instances, returns enrollment, and refreshes the registry", async () => {
        const domains = new WebTestDomains();
        const draft = {
            approvalPolicy: { mode: "disabled" as const },
            enabled: true,
            extensions: { model: ["instance"] },
            mcp: {
                auth: "none" as const,
                contextMode: "explicit" as const,
                enabled: true,
            },
            name: "reverse-web",
            provider: "reverse" as const,
            security: { mode: "disabled" as const },
            workspace: { enabled: true },
        } satisfies InstanceCreateDraft;
        const create = vi.fn(async (_draft: InstanceCreateDraft) => ({
            enabled: true,
            name: "reverse-web",
        }));
        const createCode = vi.fn(async (_instance: string) => ({
            controllerUrl: "https://controller.example.test",
            deviceCode: "device-code",
            expiresAt: "2026-09-16T12:00:00.000Z",
            instance: asInstanceName("reverse-web"),
        }));
        domains.domains.instances.create = create;
        domains.domains.reverse.createCode = createCode;
        const refresh = vi.spyOn(domains.domains.instances, "refresh");
        const store = new WebStore(domains.domains);
        await store.load();

        const result = await store.createInstance(draft);

        expect(create).toHaveBeenCalledWith(draft);
        expect(refresh).toHaveBeenCalled();
        expect(createCode).toHaveBeenCalledWith("reverse-web");
        expect(result).toEqual({
            enrollment:
                "devshell-worker enroll --controller https://controller.example.test --device-code device-code (expires 2026-09-16T12:00:00.000Z)",
            succeeded: true,
        });
        store.close();
    });
});

describe("WebStore recovery and consistency", () => {
    it("returns the result of each Context message operation independently", async () => {
        const domains = new WebTestDomains();
        const queue = vi.fn(
            async (
                _instance: string,
                ctxId: string,
                text: string,
            ): Promise<ContextMessageRecord> => {
                if (ctxId === "ctx-b") throw new Error("queue b failed");
                return {
                    createdAt: "2026-07-31T00:00:00Z",
                    ctxId,
                    id: ctxId,
                    instance: "demo",
                    status: "pending",
                    text,
                };
            },
        );
        domains.domains.messages.queue = queue;
        const store = new WebStore(domains.domains);
        await store.load();

        const result = await Promise.all([
            store.queueContextMessage("demo", "ctx-a", "A"),
            store.queueContextMessage("demo", "ctx-b", "B"),
        ]);

        expect(result).toEqual([true, false]);
        expect(store.state.error).toBe("queue b failed");
    });

    it("loads logs with Tool Calls when Audit is materialized", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ mcpEnabled: true, name: "demo", snapshot }]);
        domains.setRuntime("demo", {
            logs: [
                {
                    at: "2026-07-31T00:00:01Z",
                    callId: "call-1",
                    instanceName: asInstanceName("demo"),
                    message: "output",
                    seq: 4,
                    stream: "stdout",
                },
            ],
        });
        const readLogs = vi.spyOn(domains.domains.runtime("demo"), "readLogs");
        const store = new WebStore(domains.domains);

        await store.load();
        expect(readLogs).not.toHaveBeenCalled();
        await store.refreshAudit();

        expect(readLogs).toHaveBeenCalledOnce();
        expect(domains.runtime("demo").state.logs?.[0]?.callId).toBe("call-1");
    });
});

describe("WebStore operation and transport boundaries", () => {
    it("restarts Control through reconnect without cancelling its own result", async () => {
        const domains = new WebTestDomains();
        const restart = vi.fn(async () => ({}));
        const reconnect = vi.fn(async () => undefined);
        domains.domains.service.restart = restart;
        domains.domains.reconnect = reconnect;
        const store = new WebStore(domains.domains);
        await store.load();

        await expect(store.restartControl()).resolves.toBe(true);

        expect(restart).toHaveBeenCalledOnce();
        expect(reconnect).toHaveBeenCalledOnce();
        expect(domains.service.state.status).toBe("online");
        expect(store.state.notice).toBe("Control runtime restarted.");
    });

    it("completes a successful lifecycle operation without waiting for auxiliary reads", async () => {
        const domains = new WebTestDomains();
        const runtime = domains.domains.runtime("demo");
        runtime.load = vi.fn(async (_instance: string) => undefined);
        const running: InstanceSnapshot = {
            ...snapshot,
            lastSeq: 10,
            status: "running",
        };
        runtime.start = vi.fn(async (_options?: ProcessStartOptions) => {
            domains.setRuntime("demo", { snapshot: running });
            return running;
        });
        const store = new WebStore(domains.domains, { requestTimeoutMs: 0 });
        await store.load();

        await store.start("demo");

        expect(domains.runtime("demo").state.snapshot?.status).toBe("running");
        expect(store.state.operations["start:demo"]).toBeUndefined();
    });

    it("clears a primary operation when its RPC exceeds the operation timeout", async () => {
        vi.useFakeTimers();
        const domains = new WebTestDomains();
        const runtime = domains.domains.runtime("demo");
        runtime.load = vi.fn(async (_instance: string) => undefined);
        let operationSignal: AbortSignal | undefined;
        runtime.start = vi.fn(async (options?: ProcessStartOptions) => {
            operationSignal = options?.signal;
            return await new Promise<InstanceSnapshot>(() => undefined);
        });
        const store = new WebStore(domains.domains, {
            operationTimeoutMs: 100,
        });
        await store.load();

        const request = store.start("demo");
        await vi.advanceTimersByTimeAsync(100);
        await request;

        expect(store.state.operations["start:demo"]).toBeUndefined();
        expect(operationSignal?.aborted).toBe(true);
        expect(store.state.error).toBeTruthy();
    });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
