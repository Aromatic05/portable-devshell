import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { CONTROL_REMOTE_RPC_PATH, CONTROL_REMOTE_RPC_SUBPROTOCOL, type Channel } from "@portable-devshell/shared";
import { ControlWebSocketListener } from "../../../../control/src/server/web/Socket.ts";
import { ControlWebSocketAccessService } from "../../../../control/src/server/web/auth/Access.ts";
import { ControlWebSessionService } from "../../../../control/src/server/web/auth/Session.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { betaOAuth, betaResource, seedAccess } from "../../support/BetaOAuth.ts";

async function socketFixture() {
    const runtime = betaOAuth(await createTestTempDirectory("round3-oauth-socket"));
    const controlResource = new URL("http://mcp.example.test/control");
    const config = { requiredScopes: ["control"], resourceName: "control" };
    runtime.registerResource(controlResource, config);
    await runtime.warmup();
    const sessions = new ControlWebSessionService({ auth: { mode: "oauth2", oauth2: config } });
    const access = new ControlWebSocketAccessService({
        sessions, verifyBearer: (token) => runtime.verifyAccessToken(controlResource, token),
        onBearerRevoked: (listener) => runtime.onAccessRevoked(listener),
    });
    type Upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
    const upgrades = new Map<string, Upgrade>();
    const listener = new ControlWebSocketListener({ access, sessions,
        http: {
            registerRawRoute() { return () => {}; },
            registerUpgradeHandler(path: string, handler: Upgrade) { upgrades.set(path, handler); return () => { upgrades.delete(path); }; },
        } as unknown as ConstructorParameters<typeof ControlWebSocketListener>[0]["http"],
    });
    const accepted: Channel[] = [];
    const sockets: Duplex[] = [];
    await listener.start(({ channel }) => { accepted.push(channel); });
    return { runtime, controlResource, accepted,
        async connect(token: string) {
            const chunks: Buffer[] = [];
            const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
            sockets.push(socket);
            const request = new IncomingMessage(new Socket());
            request.method = "GET";
            request.url = CONTROL_REMOTE_RPC_PATH;
            request.headers = {
                host: "mcp.example.test", authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "sec-websocket-protocol": CONTROL_REMOTE_RPC_SUBPROTOCOL,
            };
            const upgrade = upgrades.get(CONTROL_REMOTE_RPC_PATH);
            assert.ok(upgrade);
            await upgrade(request, socket, Buffer.alloc(0));
            request.destroy();
            return Buffer.concat(chunks).toString("utf8");
        },
        async close() { for (const socket of sockets) socket.destroy(); await listener.close(); },
    };
}

test("round3 OAuth actual token destruction closes only existing WebSockets for its grant and rejects MCP audience at Control upgrade", async () => {
    const fixture = await socketFixture();
    try {
        await seedAccess(fixture.runtime, "grant-a-token", { aud: fixture.controlResource.href, scope: "control", grantId: "grant-a" });
        await seedAccess(fixture.runtime, "grant-b-token", { aud: fixture.controlResource.href, scope: "control", grantId: "grant-b" });
        await seedAccess(fixture.runtime, "mcp-only", { aud: betaResource.href, scope: "control mcp" });
        assert.match(await fixture.connect("mcp-only"), /^HTTP\/1\.1 401/u);
        assert.equal(fixture.accepted.length, 0);
        assert.match(await fixture.connect("grant-a-token"), /^HTTP\/1\.1 101/u);
        assert.match(await fixture.connect("grant-b-token"), /^HTTP\/1\.1 101/u);
        assert.equal(fixture.accepted.length, 2);
        const destroyed = await fixture.runtime.provider.AccessToken.find("grant-a-token");
        assert.ok(destroyed);
        await destroyed.destroy();
        assert.equal(fixture.accepted[0]!.closed, true);
        assert.equal(fixture.accepted[1]!.closed, false);
        assert.match(await fixture.connect("grant-a-token"), /^HTTP\/1\.1 401/u);
        assert.equal(fixture.accepted.length, 2);
    } finally { await fixture.close(); }
});

test("round3 OAuth exact bearer expiration closes an existing WebSocket and refuses reconnection", async (t) => {
    const fixture = await socketFixture();
    try {
        const now = Math.floor(Date.now() / 1000) * 1000;
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
        await seedAccess(fixture.runtime, "expires-on-next-second", { aud: fixture.controlResource.href, scope: "control", exp: now / 1000 + 1 });
        assert.match(await fixture.connect("expires-on-next-second"), /^HTTP\/1\.1 101/u);
        assert.equal(fixture.accepted[0]!.closed, false);
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, true);
        assert.match(await fixture.connect("expires-on-next-second"), /^HTTP\/1\.1 401/u);
        assert.equal(fixture.accepted.length, 1);
    } finally { t.mock.timers.reset(); await fixture.close(); }
});
