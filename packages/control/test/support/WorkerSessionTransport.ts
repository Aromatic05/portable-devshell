import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import type { Instance } from "@portable-devshell/core";
import {
    CONTROL_PROTOCOL_RANGE, Endpoint, Rpc, StreamChannel, routeModule,
    type ControlHostDefinition, type ControlClientKind,
} from "@portable-devshell/shared";
import { ControlTransportServer } from "../../src/server/transport/endpoint/Server.ts";
import type { ControlAcceptedChannel, ControlTransportAdmission, ControlTransportListener } from "../../src/server/transport/channel/Listener.ts";
import { negotiateControlProtocol } from "../../src/server/Protocol.ts";

/** In-process Channels only; the production Endpoint, Gateway and Instance hosts. */
export async function workerSessionTransport(
    t: TestContext,
    instances: readonly Instance[],
    extraHosts: () => readonly ControlHostDefinition[] = () => [],
) {
    let accept!: (connection: ControlAcceptedChannel) => void;
    const channels = new Set<StreamChannel>();
    const listener: ControlTransportListener = {
        async start(handler) { accept = handler; },
        async close() { for (const channel of channels) channel.close(); },
    };
    const clients: Endpoint[] = [];
    const client = (options: {
        host?: string;
        peer?: ControlClientKind;
        admission?: ControlTransportAdmission;
    } = {}) => {
        const endpoint = new Endpoint({
            host: options.host,
            connectChannel: async () => {
                const up = new PassThrough();
                const down = new PassThrough();
                let closed = false;
                const closeTransport = (error?: Error) => {
                    if (closed) return;
                    closed = true;
                    up.destroy(); down.destroy();
                    channel.close(error);
                    serverChannel.close(error);
                };
                const channel = new StreamChannel(down, up, { closeTransport });
                const serverChannel = new StreamChannel(up, down, { closeTransport });
                channels.add(channel);
                channels.add(serverChannel);
                accept({ channel: serverChannel, admission: options.admission ?? {
                    allowedPeers: ["cli"], subject: { kind: "local-owner", id: "test-owner" },
                } });
                return channel;
            },
            initializeConnection: async (connect) => {
                const rpc = new Rpc(connect("@control", "server"));
                try {
                    await rpc.request("hello", { clientKind: options.peer ?? "cli", protocolRange: CONTROL_PROTOCOL_RANGE });
                } finally { rpc.close(); }
            },
        });
        clients.push(endpoint);
        return endpoint;
    };
    const endpoint = client();
    let current = [...instances];
    const changes = new Set<() => void>();
    const server = new ControlTransportServer({
        listeners: [listener],
        routes: {
            hosts: () => [
                { host: "@control", ports: [routeModule("server", {
                    hello: (request, context) => negotiateControlProtocol(request.payload, context.peer) as never,
                })] },
                ...current.map((instance) => instance.host([], undefined, endpoint.host)),
                ...extraHosts(),
            ],
            onChange(handler) { changes.add(handler); return () => changes.delete(handler); },
        },
    });
    t.after(async () => {
        for (const endpoint of clients) endpoint.close();
        await server.close();
    });
    await server.start();
    return {
        endpoint, server, client,
        replace(instances: readonly Instance[]) {
            current = [...instances];
            for (const handler of changes) handler();
        },
    };
}
