import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMcpRouteEntries } from "../../src/protocol/Route.ts";
import { McpExtensionRegistry } from "../../src/protocol/extension/Registry.ts";
import { authFixture, contextId, resourceUri, resourceText } from "./AuthTransportRound4Support.ts";

test("round4 HTTP auth gates discovery and resources before dispatch", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    for (const [method, params] of [["server/discover", {}], ["resources/list", {}], ["resources/read", { uri: resourceUri }]] as const) {
        assert.equal((await f.raw(undefined, method, params)).status, 401);
        assert.equal((await f.raw("invalid-round4-token", method, params)).status, 401);
    }
    assert.equal(f.resourceReads(), 0);
    const client = await f.connect(alpha.token);
    assert.ok((await client.listResources()).resources.some(({ uri }) => uri === resourceUri));
    assert.equal(resourceText((await client.readResource({ uri: resourceUri })).contents[0]), "authenticated fixture resource");
    assert.equal(f.resourceReads(), 1);
    assert.equal(f.dispatches.length, 0);
});

test("round4 two SDK clients isolate Context despite forged principal and identical session metadata", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha", "subject-alpha");
    const beta = await f.issue("beta", "subject-beta");
    const [a, b] = await Promise.all([f.connect(alpha.token), f.connect(beta.token)]);
    const info = (client: typeof a, workspace: string) => client.callTool({ name: "environ_info", arguments: { workspace },
        _meta: { "openai/session": "same-session", principal: "forged-subject" } });
    const [ar, br] = await Promise.all([info(a, join(f.directory, "a")), info(b, join(f.directory, "b"))]);
    const aId = (ar.structuredContent as { ctxId: string }).ctxId;
    const bId = (br.structuredContent as { ctxId: string }).ctxId;
    assert.ok(aId);
    assert.ok(bId);
    assert.notEqual(aId, bId);
    const before = await f.runtime.contexts.registry.list();
    assert.equal(before.find(({ ctxId }) => ctxId === aId)?.principal, alpha.subject);
    assert.equal(before.find(({ ctxId }) => ctxId === bId)?.principal, beta.subject);
    for (const [client, target, directory] of [[a, bId, "b"], [b, aId, "a"]] as const) {
        await assert.rejects(client.callTool({ name: "environ_info", arguments: { ctxId: target, workspace: join(f.directory, directory) } }), (error: unknown) => { assert.ok(error instanceof Error && "data" in error); assert.equal((error.data as { code: string }).code, "mcp.contextInvalid"); return true; });
        await assert.rejects(client.callTool({ name: "environ_info", arguments: { ctxId: target, workspace: join(f.directory, "stolen") } }), (error: unknown) => { assert.ok(error instanceof Error && "data" in error); assert.equal((error.data as { code: string }).code, "mcp.contextInvalid"); return true; });
    }
    assert.deepEqual(await f.runtime.contexts.registry.list(), before);
    assert.equal((await a.callTool({ name: "environ_info", arguments: { ctxId: aId, workspace: join(f.directory, "a") } })).isError, false);
    assert.equal((await b.callTool({ name: "environ_info", arguments: { ctxId: bId, workspace: join(f.directory, "b2") } })).isError, false);
    assert.equal((await f.runtime.contexts.registry.list()).find(({ ctxId }) => ctxId === bId)?.environments[0]?.workspace, join(f.directory, "b2"));
});

test("round4 access revoke rejects a connected client while another grant remains usable", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    const beta = await f.issue("beta");
    const [a, b] = await Promise.all([f.connect(alpha.token), f.connect(beta.token)]);
    await a.readResource({ uri: resourceUri });
    await b.readResource({ uri: resourceUri });
    assert.equal((await f.form("/revoke", { token: alpha.token, client_id: alpha.clientId, token_type_hint: "access_token" })).status, 200);
    const before = f.resourceReads();
    await assert.rejects(a.readResource({ uri: resourceUri }));
    assert.equal((await f.raw(alpha.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "revoked") } })).status, 401);
    assert.equal(f.resourceReads(), before);
    assert.equal((await f.runtime.contexts.registry.list()).length, 0);
    assert.equal(resourceText((await b.readResource({ uri: resourceUri })).contents[0]), "authenticated fixture resource");
});

test("round4 wrong-client revoke is inert and rotated refresh replay revokes its successors over HTTP", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    const beta = await f.issue("beta");
    assert.equal((await f.form("/revoke", { token: alpha.token, client_id: beta.clientId })).status, 200);
    assert.equal((await f.raw(alpha.token, "resources/read", { uri: resourceUri })).status, 200);
    const fields = { grant_type: "refresh_token", client_id: alpha.clientId, refresh_token: alpha.refresh };
    const rotated = await f.form("/token", fields);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refresh_token, alpha.refresh);
    assert.equal((await f.raw(rotated.body.access_token, "resources/list")).status, 200);
    const replay = await f.form("/token", fields);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    assert.equal((await f.raw(alpha.token, "resources/list")).status, 401);
    assert.equal((await f.raw(rotated.body.access_token, "resources/read", { uri: resourceUri })).status, 401);
    assert.equal((await f.raw(beta.token, "resources/list")).status, 200);
});

test("round4 bearer audience prevents reads and Context creation on another namespace", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    for (const method of ["server/discover", "resources/list", "resources/read", "tools/call"]) {
        assert.equal((await f.raw(alpha.token, method, { uri: resourceUri, name: "environ_info", arguments: { workspace: join(f.directory, "wrong-audience") } }, "/other/mcp")).status, 401);
    }
    assert.equal(f.resourceReads(), 0);
    assert.equal(f.dispatches.length, 0);
    assert.deepEqual(await f.runtime.contexts.registry.list(), []);
    assert.equal((await f.raw(alpha.token, "resources/list")).status, 200);
});

test("agy conversation binding is isolated by the verified OAuth subject", async (t) => {
    const f = await authFixture(t, "agy-session");
    const alpha = await f.issue("alpha", "subject-alpha");
    const beta = await f.issue("beta", "subject-beta");
    const key = "antigravity.google/conversation_id";
    const bootstrap = (token: string, workspace: string) => f.raw(token, "tools/call", {
        name: "environ_info", arguments: { workspace }, _meta: { [key]: "shared-session", principal: beta.subject },
    });
    const a = await bootstrap(alpha.token, join(f.directory, "a"));
    const b = await bootstrap(beta.token, join(f.directory, "b"));
    for (const response of [a, b]) {
        assert.equal(response.payload.error, undefined);
        assert.equal(response.payload.result?.structuredContent?.ctxId, undefined);
    }
    const records = await f.runtime.contexts.registry.list();
    assert.equal(records.length, 2);
    const aContext = records.find((record) => record.principal === alpha.subject);
    const bContext = records.find((record) => record.principal === beta.subject);
    assert.ok(aContext);
    assert.ok(bContext);
    assert.notEqual(aContext.ctxId, bContext.ctxId);
    const binding = { kind: key, value: "shared-session" };
    assert.equal((await f.runtime.contexts.registry.lookupExternal(binding, { principal: alpha.subject }))?.ctxId, aContext.ctxId);
    assert.equal((await f.runtime.contexts.registry.lookupExternal(binding, { principal: beta.subject }))?.ctxId, bContext.ctxId);
    const override = await f.raw(alpha.token, "tools/call", {
        name: "environ_info", arguments: { ctxId: bContext.ctxId, workspace: join(f.directory, "a2") },
        _meta: { [key]: "shared-session", principal: beta.subject },
    });
    assert.equal(override.payload.error, undefined);
    const after = await f.runtime.contexts.registry.list();
    assert.equal(after.length, 2);
    assert.equal(after.find((record) => record.ctxId === aContext.ctxId)?.environments[0]?.workspace, join(f.directory, "a2"));
    assert.equal(after.find((record) => record.ctxId === bContext.ctxId)?.environments[0]?.workspace, join(f.directory, "b"));
});

test("round4 explicit Context survives bearer rotation without storing credentials", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    const workspace = join(f.directory, "a");
    const ctxId = contextId((await f.raw(alpha.token, "tools/call", { name: "environ_info", arguments: { workspace } })).payload);
    const rotated = await f.form("/token", { grant_type: "refresh_token", client_id: alpha.clientId, refresh_token: alpha.refresh });
    assert.equal(rotated.status, 200);
    assert.equal(contextId((await f.raw(rotated.body.access_token, "tools/call", { name: "environ_info", arguments: { ctxId, workspace }, _meta: { "openai/session": "different-session" } })).payload), ctxId);
    assert.equal((await f.runtime.contexts.registry.list()).length, 1);
    const persisted = await readFile(join(f.directory, "contexts.jsonl"), "utf8");
    assert.ok(persisted.includes(ctxId));
    assert.equal(persisted.includes(alpha.token), false);
    assert.equal(persisted.includes(rotated.body.access_token!), false);
});

test("round4 established SDK client cannot cache authorization across expiry and scope removal", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    const beta = await f.issue("beta");
    const client = await f.connect(alpha.token);
    await client.readResource({ uri: resourceUri });
    const access = await f.seed.provider.AccessToken.find(alpha.token);
    assert.ok(access);
    const original = await f.seed.provider.AccessToken.adapter.find(access.jti);
    assert.ok(original);
    const before = f.resourceReads();
    // Adapter TTL stays live; the token's own exact-second exp must win.
    await f.seed.provider.AccessToken.adapter.upsert(access.jti, { ...original, exp: Math.floor(Date.now() / 1000) }, 3600);
    assert.ok(await f.seed.provider.AccessToken.adapter.find(access.jti));
    await assert.rejects(client.readResource({ uri: resourceUri }));
    assert.equal(f.resourceReads(), before);
    await f.seed.provider.AccessToken.adapter.upsert(access.jti, { ...original, scope: "offline_access" }, 3600);
    assert.equal((await f.raw(alpha.token, "resources/list")).status, 401);
    assert.equal(f.resourceReads(), before);
    assert.equal((await f.raw(beta.token, "resources/read", { uri: resourceUri })).status, 200);
    assert.deepEqual(await f.runtime.contexts.registry.list(), []);
});

test("round4 same verified subject may reuse its Context through two distinct OAuth clients", async (t) => {
    const f = await authFixture(t);
    const alpha = await f.issue("alpha");
    const beta = await f.issue("beta");
    assert.notEqual(alpha.clientId, beta.clientId);
    assert.equal(alpha.subject, beta.subject);
    const ctxId = contextId((await f.raw(alpha.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "owner") } })).payload);
    const b = await f.connect(beta.token);
    const result = await b.callTool({ name: "environ_info", arguments: { ctxId, workspace: join(f.directory, "owner-updated") } });
    assert.equal((result.structuredContent as { ctxId: string }).ctxId, ctxId);
    assert.equal((await f.runtime.contexts.registry.list()).length, 1);
    assert.equal((await f.runtime.contexts.registry.lookup(ctxId, { principal: alpha.subject })).environments[0]?.workspace, join(f.directory, "owner-updated"));
});

test("round4 live static bearer rotation rejects the stale client on tools and resources and changes Context authority", async (t) => {
    const f = await authFixture(t);
    const { McpAuthProviderToken } = await import("../../src/oauth/Provider.ts");
    const credential = new McpAuthProviderToken("round4-static-old").authenticate("Bearer round4-static-old");
    assert.ok(credential);
    const record = await f.runtime.contexts.registry.create({ principal: credential.clientId, environments: [{ instance: "static", workspace: join(f.directory, "static") }] });
    const mount = (token: string) => f.protocol.register("static", createMcpRouteEntries({ instanceName: "static",
        auth: { enabled: true, provider: "token", token }, context: f.runtime.contextTransport,
        tools: f.runtime.toolCallRuntime.api, toolSource: f.runtime.toolSource,
        extensions: new McpExtensionRegistry([{ id: "static-resource", resources: [{ uri: resourceUri, name: "Static", mimeType: "text/plain", read: () => ({ text: "static generation" }) }] }]),
    }, ["/static/mcp"]));
    mount("round4-static-old");
    assert.equal((await f.raw("round4-static-old", "resources/read", { uri: resourceUri }, "/static/mcp")).status, 200);
    mount("round4-static-new");
    for (const method of ["resources/list", "resources/read", "tools/list", "tools/call"]) {
        assert.equal((await f.raw("round4-static-old", method, { uri: resourceUri, name: "environ_info", arguments: { ctxId: record.ctxId } }, "/static/mcp")).status, 401);
    }
    assert.equal((await f.raw("round4-static-new", "resources/read", { uri: resourceUri }, "/static/mcp")).status, 200);
    const denied = await f.raw("round4-static-new", "tools/call", { name: "environ_info", arguments: { ctxId: record.ctxId, workspace: join(f.directory, "static") } }, "/static/mcp");
    assert.equal(denied.payload.error?.data?.code, "mcp.contextInvalid");
    assert.deepEqual(await f.runtime.contexts.registry.lookup(record.ctxId, { principal: credential.clientId }), record);
});
