import {
    CONTROL_PROTOCOL_RANGE, Endpoint, StreamChannel, Rpc, createToolCallRuntime,
    createToolCallTargetTransport, createToolRouteModule, routeModule,
} from "@portable-devshell/shared";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { negotiateControlProtocol } from "../../../../src/server/Protocol.ts";
import { ControlTransportServer } from "../../../../src/server/transport/endpoint/Server.ts";
import type { ControlAcceptedChannel } from "../../../../src/server/transport/channel/Listener.ts";
import { round4Target } from "../../../../../core/test/unit/tool/Round4Harness.ts";

export async function round4Control() {
    const target = await round4Target();
    // OS stdio pipes exercise framing and asynchronous delivery without a
    // listening socket (which the normal Codex workspace rejects with EPERM).
    let accept!: (connection: ControlAcceptedChannel) => void;
    const childExits: Promise<unknown>[] = [];
    const pipePair = () => {
        const forward = spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] });
        const backward = spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] });
        childExits.push(once(forward, "exit"), once(backward, "exit"));
        const closeTransport = () => { forward.stdin!.end(); backward.stdin!.end(); };
        const client = new StreamChannel(backward.stdout!, forward.stdin!, { closeTransport });
        const server = new StreamChannel(forward.stdout!, backward.stdin!, { closeTransport });
        accept({ channel: server, admission: {
            allowedPeers: ["cli"], subject: { id: "round4-local-pipes", kind: "local-owner" },
        } });
        return client;
    };
    const endpoints: Endpoint[] = [];
    const connect = async (host?: string) => {
        const endpoint = new Endpoint({ host,
            connectChannel: async () => pipePair(),
            initializeConnection: async (open) => {
                const rpc = new Rpc(open("@control", "server"));
                try { await rpc.request("hello", { clientKind: "cli", protocolRange: CONTROL_PROTOCOL_RANGE }); }
                finally { rpc.close(); }
            },
        });
        endpoints.push(endpoint);
        return endpoint;
    };
    const bridge = await connect("round4-bridge");
    const runtime = createToolCallRuntime({
        resolveTarget: (instance) => createToolCallTargetTransport(bridge, instance),
    });
    const toolRoute = createToolRouteModule({ name: "round4", worker: {
        readWorkerTools: async () => [],
        prepareWorkspace: async (workspace) => ({ workspace }),
        readToolCalls: (query) => target.history.read(query),
        readToolCallFailureSummary: async (since, until) => target.history.readFailureSummary(since, until),
        dispatchToolCall: (request) => target.tool.target().dispatch(request),
        releaseToolSession: async () => {},
    } }, undefined, runtime.api);
    const server = new ControlTransportServer({ listeners: [{
        async start(callback) { accept = callback; }, async close() {},
    }], routes: {
        hosts: () => [
            { host: "@control", ports: [routeModule("server", { hello: async (request, context) => ({ ...negotiateControlProtocol(request.payload, context.peer) }) })] },
            { host: "round4", ports: [toolRoute] },
        ], onChange: () => () => {},
    } });
    await server.start();
    return { ...target, runtime, bridge, connect, server,
        async close() {
            for (const endpoint of endpoints) endpoint.close();
            await server.close(); await Promise.all(childExits); runtime.close(); await target.close();
        },
    };
}
