// Isolated-runtime fixture: each Worker or CLI invocation rebuilds OIDC and adapter caches.
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMcpOAuthOidcAdapterFactory } from "../../src/oauth/provider/Adapter.ts";
import { importJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { Round4MemoryHttp } from "./AuthTransportRound4MemoryHttp.ts";

const [directory, phase, signed] = workerData ?? process.argv.slice(2);
assert.ok(directory);
const http = new Round4MemoryHttp();
const config = { requiredScopes: ["mcp"], resourceName: "restart-round4" };
const resource = new URL(`${http.origin}/demo/mcp`);
const runtime = new McpOAuthProviderRuntime({ accountId: "process-restart-fixture",
    approvals: new McpOAuthApprovalService(directory), config, publicBaseUrl: http.origin, storageDir: directory });
const release = runtime.registerResource(resource, config);
await runtime.warmup();
http.registerMiddleware("/", (request, response) => { runtime.provider.callback()(request, response); });
const metadata = await (await http.fetch(`${http.origin}/.well-known/openid-configuration`)).json();
const jwks = await (await http.fetch(`${http.origin}/jwks`)).json();
const privateSource = await readFile(join(directory, "jwks.json"), "utf8");
let signature = signed;
if (phase === "seed") {
    const key = JSON.parse(privateSource).keys[0];
    signature = await new SignJWT({ fixture: "persisted-signing-key" }).setProtectedHeader({ alg: key.alg, kid: key.kid })
        .setIssuer(http.origin).setAudience(resource.href).setExpirationTime("1h").sign(await importJWK(key, key.alg));
    const now = Math.floor(Date.now() / 1000);
    for (const id of ["restart-live", "restart-revoked"]) {
        await runtime.provider.AccessToken.adapter.upsert(id, { aud: resource.href, clientId: "restart-client",
            jti: id, accountId: runtime.accountId, exp: now + 3600, iat: now, grantId: "restart-grant", kind: "AccessToken", scope: "mcp" }, 3600);
    }
    const revoked = await runtime.provider.AccessToken.find("restart-revoked");
    assert.ok(revoked);
    await revoked.destroy();
}
const redirect = `${http.origin}/restart-client-callback`;
if (phase === "seed") await runtime.registerFirstPartyWebClient(redirect, ["mcp"]);
const database = new DatabaseSync(join(directory, "adapter", "oidc.sqlite3"), { readOnly: true });
const clients = database.prepare("SELECT id, payload FROM oidc_records WHERE model = 'Client'").all() as Array<{ id: string; payload: string }>;
database.close();
assert.equal(clients.length, 1);
const clientId = clients[0]!.id;
const clientsSource = clients[0]!.payload;
assert.ok(clientId);
assert.ok(await runtime.provider.Client.find(clientId));
assert.equal(await runtime.registerFirstPartyWebClient(redirect, ["mcp"]), clientId);
assert.equal(JSON.stringify(await createMcpOAuthOidcAdapterFactory(join(directory, "adapter"))("Client").find(clientId)), clientsSource);
assert.ok(signature);
await jwtVerify(signature, createLocalJWKSet(jwks), { issuer: http.origin, audience: resource.href });
const verified = await runtime.verifyAccessToken(resource, "restart-live");
await assert.rejects(runtime.verifyAccessToken(resource, "restart-revoked"), /invalid|expired/iu);
release();
const result = { clientId, clientDigest: createHash("sha256").update(clientsSource).digest("hex"), metadata, jwks, privateDigest: createHash("sha256").update(privateSource).digest("hex"), signature, verified };
if (parentPort) { parentPort.postMessage(result); parentPort.close(); }
else console.log(JSON.stringify(result));
