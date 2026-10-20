import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { CONTROL_REMOTE_RPC_PATH, CONTROL_REMOTE_RPC_SUBPROTOCOL, type Channel } from "@portable-devshell/shared";
import { ControlWebSocketListener } from "../../../../control/src/server/web/Socket.ts";
import { ControlWebSocketAccessService } from "../../../../control/src/server/web/auth/Access.ts";
import { ControlWebSessionService } from "../../../../control/src/server/web/auth/Session.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { betaConfig, betaOAuth, betaResource, oidcRequest, seedAccess, seedRefresh } from "../../support/BetaOAuth.ts";
import { Round4MemoryHttp } from "../../integration/AuthTransportRound4MemoryHttp.ts";
import { createMcpOAuthOidcAdapterFactory } from "../../../src/oauth/provider/Adapter.ts";

async function socketFixture(controlResource = new URL("http://mcp.example.test/control"), config = { requiredScopes: ["control"], resourceName: "control" }) {
    const directory = await createTestTempDirectory("round3-oauth-socket");
    const runtime = betaOAuth(directory);
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
    return { directory, runtime, controlResource, accepted,
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

test("OAuth durable replay revocation closes sockets in another runtime without closing a healthy peer", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const fixture = await socketFixture(betaResource, betaConfig);
    const seen: string[] = [];
    const unsubscribe = fixture.runtime.onAccessRevoked(({ grantId }) => seen.push(grantId));
    try {
        const other = betaOAuth(fixture.directory);
        await other.warmup();
        const owner = await seedRefresh(fixture.runtime);
        const peer = await seedRefresh(fixture.runtime);
        const fields = { client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token };
        const issued = await oidcRequest(fixture.runtime, "/token", fields);
        const healthy = await oidcRequest(fixture.runtime, "/token", { ...fields, refresh_token: peer.token });
        assert.equal(issued.status, 200);
        assert.equal(healthy.status, 200);
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 101/u);
        assert.match(await fixture.connect(healthy.body.access_token!), /^HTTP\/1\.1 101/u);
        // Successful rotation alone must preserve the already accepted socket.
        const rotated = await oidcRequest(other, "/token", { ...fields, refresh_token: issued.body.refresh_token! });
        assert.equal(rotated.status, 200);
        const prepare = DatabaseSync.prototype.prepare;
        let reads = 0;
        t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
            if (sql.startsWith("SELECT rowid AS sequence")) reads++;
            return prepare.call(this, sql);
        });
        t.mock.timers.tick(1000);
        assert.equal(reads, 1, "one durable read serves all runtime listeners and sockets");
        assert.equal(fixture.accepted[0]!.closed, false);
        assert.equal(fixture.accepted[1]!.closed, false);
        for (let frame = 0; frame < 16; frame++) {
            await fixture.accepted[0]!.write(Uint8Array.of(frame));
            await fixture.accepted[1]!.write(Uint8Array.of(frame));
        }
        assert.equal(reads, 1, "socket frames do not query SQLite");
        const replay = await oidcRequest(other, "/token", fields);
        assert.equal(replay.status, 400);
        assert.equal(replay.body.error, "invalid_grant");
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 401/u);
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, true);
        assert.equal(fixture.accepted[1]!.closed, false);
        t.mock.timers.tick(1000);
        assert.deepEqual(seen, [owner.grantId], "the durable cursor does not repeat a revocation");
        assert.equal((await fixture.runtime.verifyAccessToken(betaResource, healthy.body.access_token!)).grantId, peer.grantId);
        assert.equal((await oidcRequest(other, "/token", { ...fields, refresh_token: healthy.body.refresh_token! })).status, 200);
    } finally {
        unsubscribe();
        await fixture.close();
        const prepare = t.mock.method(DatabaseSync.prototype, "prepare");
        t.mock.timers.tick(1000);
        assert.equal(prepare.mock.callCount(), 0, "unsubscribed runtime must stop polling");
        prepare.mock.restore();
        t.mock.timers.reset();
    }
});

test("OAuth durable observation ignores rolled-back fences and retries a failed read without closing healthy sockets", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const fixture = await socketFixture(betaResource, betaConfig);
    const seen: string[] = [];
    const unsubscribe = fixture.runtime.onAccessRevoked(({ grantId }) => seen.push(grantId));
    try {
        const owner = await seedRefresh(fixture.runtime);
        const issued = await oidcRequest(fixture.runtime, "/token", {
            client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token,
        });
        assert.equal(issued.status, 200);
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 101/u);
        const writer = createMcpOAuthOidcAdapterFactory(join(fixture.directory, "adapter"));
        await writer.transaction(async () => {
            await writer("RefreshToken").revokeByGrantId(owner.grantId);
            t.mock.timers.tick(1000);
            assert.equal(fixture.accepted[0]!.closed, false);
            assert.deepEqual(seen, []);
        }, () => 500);
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, false);
        assert.deepEqual(seen, []);
        assert.equal((await fixture.runtime.verifyAccessToken(betaResource, issued.body.access_token!)).grantId, owner.grantId);
        await writer("RefreshToken").revokeByGrantId(owner.grantId);
        const prepare = DatabaseSync.prototype.prepare;
        const fault = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
            if (sql.startsWith("SELECT rowid AS sequence")) throw Object.assign(new Error("injected observation busy"), { code: "SQLITE_BUSY" });
            return prepare.call(this, sql);
        });
        const warnings: unknown[] = [];
        t.mock.method(console, "warn", (warning: unknown) => warnings.push(warning));
        t.mock.timers.tick(1000);
        assert.equal(warnings.length, 1);
        assert.equal(fixture.accepted[0]!.closed, false);
        assert.deepEqual(seen, []);
        fault.mock.restore();
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, true);
        assert.deepEqual(seen, [owner.grantId]);
    } finally { unsubscribe(); await fixture.close(); t.mock.timers.reset(); }
});

test("OAuth a real COMMIT followed by EIO cannot permanently lose socket revocation", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const fixture = await socketFixture(betaResource, betaConfig);
    try {
        const owner = await seedRefresh(fixture.runtime);
        const fields = { client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token };
        const issued = await oidcRequest(fixture.runtime, "/token", fields);
        assert.equal(issued.status, 200);
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 101/u);
        const exec = DatabaseSync.prototype.exec;
        let injected = 0;
        const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
            const result = exec.call(this, sql);
            if (sql === "COMMIT" && this.prepare("SELECT id FROM revoked_grants").get() !== undefined) {
                injected++;
                throw Object.assign(new Error("injected post-commit EIO"), { code: "EIO" });
            }
            return result;
        });
        const http = new Round4MemoryHttp();
        http.registerMiddleware("/", (request, response) => fixture.runtime.provider.callback()(request, response));
        const failed = await http.fetch("http://mcp.example.test/token", {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields),
        });
        await failed.text();
        assert.equal(failed.status, 500);
        fault.mock.restore();
        assert.equal(injected, 1);
        const database = new DatabaseSync(join(fixture.directory, "adapter", "oidc.sqlite3"), { readOnly: true });
        try {
            assert.deepEqual(database.prepare("SELECT id FROM revoked_grants").all().map((row) => row.id), [owner.grantId]);
        } finally { database.close(); }
        // Retry has no refresh record left and emits no replacement callback.
        assert.equal((await oidcRequest(fixture.runtime, "/token", fields)).status, 400);
        assert.equal(fixture.accepted[0]!.closed, false);
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, true);
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 401/u);
    } finally { await fixture.close(); t.mock.timers.reset(); }
});

test("OAuth replay in a separate Node process revokes an already accepted socket", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const fixture = await socketFixture(betaResource, betaConfig);
    try {
        const owner = await seedRefresh(fixture.runtime);
        const fields = { client_id: owner.clientId, grant_type: "refresh_token", refresh_token: owner.token };
        const issued = await oidcRequest(fixture.runtime, "/token", fields);
        assert.equal(issued.status, 200);
        assert.match(await fixture.connect(issued.body.access_token!), /^HTTP\/1\.1 101/u);
        const helper = new URL("../../support/BetaOAuth.ts", import.meta.url).href;
        const resultFile = join(fixture.directory, "replay-result.json");
        const script = `
            import { writeFile } from "node:fs/promises";
            import { betaOAuth, oidcRequest } from ${JSON.stringify(helper)};
            const runtime = betaOAuth(process.argv[1]);
            await runtime.warmup();
            await writeFile(process.argv[3], JSON.stringify(await oidcRequest(runtime, "/token", JSON.parse(process.argv[2]))));
        `;
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        await promisify(execFile)(process.execPath, ["--import", "tsx",
            "--input-type=module", "-e", script, fixture.directory, JSON.stringify(fields), resultFile], { timeout: 15_000, env });
        const replay = JSON.parse(await readFile(resultFile, "utf8"));
        assert.equal(replay.status, 400);
        assert.equal(replay.body.error, "invalid_grant");
        t.mock.timers.tick(1000);
        assert.equal(fixture.accepted[0]!.closed, true);
    } finally { await fixture.close(); t.mock.timers.reset(); }
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
