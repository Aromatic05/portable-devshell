import assert from "node:assert/strict";
import test from "node:test";

import { McpEndpointBinding } from "../../../../src/protocol/Binding.ts";
import { McpProtocolRoute } from "../../../../src/protocol/Route.ts";
import { HttpHost } from "../../../../src/testing/Http.ts";
import { createTestMcpEndpoint } from "../../../ContextRuntime.ts";
import { postModern } from "../../../integration/ModernProtocol.ts";

function createRoute() {
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const protocol = new McpProtocolRoute(http);
    const binding = new McpEndpointBinding(createTestMcpEndpoint({ instanceName: "demo" }));
    protocol.register({ binding, path: "/demo/mcp" });
    protocol.start();
    return { http, protocol, binding };
}

function urlFor(http: HttpHost): string {
    const address = http.address;
    assert.ok(address !== null && typeof address !== "string");
    return `http://127.0.0.1:${address.port}/demo/mcp`;
}

test("MCP generation stops admission but allows accepted work to drain", async () => {
    const { http, protocol, binding } = createRoute();
    const originalHandle = binding.handleRequest.bind(binding);
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    binding.handleRequest = async (request, response, body) => {
        admit();
        await gate;
        await originalHandle(request, response, body);
    };
    await http.start();
    try {
        const url = urlFor(http);
        const accepted = postModern(url, 1, "server/discover");
        await admitted;
        protocol.stop();
        assert.equal((await postModern(url, 2, "server/discover")).status, 404);
        await assert.rejects(protocol.drain({ timeoutMs: 10 }), /in-flight response/u);
        proceed();
        const response = await accepted;
        assert.equal(response.status, 200);
        await response.text();
        await protocol.drain({ timeoutMs: 250 });
    } finally {
        proceed();
        protocol.stop();
        await http.stop();
    }
});

test("MCP final forced drain closes the old straggler after its grace period", async () => {
    const { http, protocol, binding } = createRoute();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    binding.handleRequest = async () => { admit(); await gate; };
    await http.start();
    try {
        const url = urlFor(http);
        const accepted = postModern(url, 1, "server/discover");
        // Attach the rejection handler before the forced socket close.
        const outcome = accepted.then(
            () => "unexpected-success" as const,
            (error: unknown) => error,
        );
        await admitted;
        protocol.stop();
        await protocol.drain({ timeoutMs: 25, force: true });
        const failure = await outcome;
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /fetch|socket|terminated/iu);
        assert.equal((await postModern(url, 2, "server/discover")).status, 404);
    } finally {
        proceed();
        protocol.stop();
        await http.stop();
    }
});
