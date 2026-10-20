import { PassThrough } from "node:stream";
import {
    ApprovalViewModel, Endpoint, Rpc, Stream, StreamChannel, createApprovalTransport,
    type ApprovalRequest, type MessageStream,
} from "@portable-devshell/shared";

// Production Approval projection, RPC framing and event subscription; no ToolCall
// records are created before the review decision.
export async function approvalPeer(names: string[]) {
    const server = new Endpoint({ host: "approval-test" });
    const outbound = new PassThrough(), inbound = new PassThrough();
    const accepting = server.accept(new StreamChannel(outbound, inbound));
    const endpoint = new Endpoint({ connectChannel: async () => new StreamChannel(inbound, outbound) });
    const snapshots: string[] = [];
    const decisions: Array<{ instance: string; approvalId: string; decision: string }> = [];
    const hooks: {
        snapshot?: (instance: string) => Promise<void>;
        decide?: (instance: string, approvalId: string, decision: string) => Promise<void>;
    } = {};
    const records = new Map<string, ApprovalRequest[]>();
    const sequences = new Map<string, number>();
    const subscribers = new Map<string, Set<MessageStream>>();
    const models = new Map<string, ApprovalViewModel>();
    const services: Array<{ close(): void }> = [];
    async function publish(instance: string, type: string, approvalId: string) {
        const seq = (sequences.get(instance) ?? 0) + 1; sequences.set(instance, seq);
        for (const stream of subscribers.get(instance) ?? []) await stream.send({ name: "event", payload: {
            instanceName: instance, seq, type, at: new Date().toISOString(), data: { approvalId },
        } });
    }
    for (const instance of names) {
        const port = server.bind("approval", instance);
        services.push(new Rpc(port, {
            snapshot: async () => {
                snapshots.push(instance);
                const snapshot = structuredClone({ approvals: (records.get(instance) ?? []).filter((item) => item.status === "pending"), lastSeq: sequences.get(instance) ?? 0 });
                await hooks.snapshot?.(instance);
                return snapshot;
            },
            decide: async (value) => {
                const { approvalId, decision } = value as { approvalId: string; decision: "approve" | "deny" };
                decisions.push({ instance, approvalId, decision });
                await hooks.decide?.(instance, approvalId, decision);
                const approval = records.get(instance)?.find((item) => item.approvalId === approvalId);
                if (approval === undefined) throw new Error("Approval no longer exists");
                const decided: ApprovalRequest = { ...approval, status: decision === "approve" ? "approved" : "denied" };
                records.set(instance, (records.get(instance) ?? []).map((item) => item.approvalId === approvalId ? decided : item));
                await publish(instance, `approval.${decided.status}`, approvalId);
                return decided;
            },
        }));
        const streamService = new Stream(port);
        streamService.onOpen(async (stream, name) => {
            if (name !== "subscribe") throw new Error(`Unexpected stream ${name}`);
            const streams = subscribers.get(instance) ?? new Set<MessageStream>();
            subscribers.set(instance, streams); streams.add(stream);
            stream.onClose(() => streams.delete(stream)); stream.onCancel(() => streams.delete(stream));
            await stream.send({ name: "seed", payload: { events: [] } });
        });
        services.push(streamService);
        models.set(instance, new ApprovalViewModel(createApprovalTransport(endpoint, instance)));
    }
    await endpoint.connect(names[0]!, "approval");
    await accepting;
    return {
        models, hooks, snapshots, decisions,
        reset() {
            for (const [instance, model] of models) {
                model.close();
                models.set(instance, new ApprovalViewModel(createApprovalTransport(endpoint, instance)));
            }
        },
        subscribers: (instance: string) => subscribers.get(instance)?.size ?? 0,
        async put(instance: string, approvals: ApprovalRequest[]) {
            records.set(instance, approvals);
            await publish(instance, "approval.requested", approvals[0]?.approvalId ?? "removed");
        },
        close() {
            for (const model of models.values()) model.close();
            for (const service of services) service.close();
            endpoint.close(); server.close(); outbound.destroy(); inbound.destroy();
        },
    };
}
