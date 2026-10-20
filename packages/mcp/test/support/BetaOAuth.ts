import assert from "node:assert/strict";
import { once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";

export const betaResource = new URL("http://mcp.example.test/demo/mcp");
export const betaConfig = { requiredScopes: ["mcp"], resourceName: "round3" };

export function betaOAuth(storageDir: string) {
    const runtime = new McpOAuthProviderRuntime({
        accountId: "round3-account", approvals: new McpOAuthApprovalService(storageDir),
        config: betaConfig, publicBaseUrl: "http://mcp.example.test/", storageDir,
    });
    runtime.registerResource(betaResource, betaConfig);
    return runtime;
}

// Actual OIDC callback, request parser, and ServerResponse; no localhost listener.
export async function oidcRequest(runtime: McpOAuthProviderRuntime, path: string, fields: Record<string, string>) {
    const body = new URLSearchParams(fields).toString();
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.url = path;
    request.headers = { host: "mcp.example.test", "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) };
    request.httpVersionMajor = 1;
    request.httpVersionMinor = 0;
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    const finished = once(response, "finish");
    request.push(body);
    request.push(null);
    runtime.provider.callback()(request, response);
    await finished;
    const wire = Buffer.concat(chunks).toString("utf8");
    socket.destroy();
    request.destroy();
    const payload = wire.slice(wire.indexOf("\r\n\r\n") + 4);
    return { status: response.statusCode, body: (payload.length === 0 ? {} : JSON.parse(payload)) as Record<string, string> };
}

export async function seedRefresh(runtime: McpOAuthProviderRuntime, suffix = "a") {
    const clientId = await runtime.registerFirstPartyWebClient(`http://mcp.example.test/callback-${suffix}`, ["mcp"]);
    const client = await runtime.provider.Client.find(clientId);
    assert.ok(client);
    const grant = new runtime.provider.Grant({ accountId: runtime.accountId, clientId });
    grant.addResourceScope(betaResource.href, "mcp");
    const grantId = await grant.save();
    const refresh = new runtime.provider.RefreshToken({
        accountId: runtime.accountId, client, grantId, gty: "authorization_code", resource: [betaResource.href], scope: "mcp offline_access",
    });
    const token = await refresh.save();
    return { clientId, grantId, token };
}

export async function seedAccess(runtime: McpOAuthProviderRuntime, id: string, overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    await runtime.provider.AccessToken.adapter.upsert(id, {
        aud: betaResource.href, clientId: "round3-client", exp: now + 3600,
        grantId: "round3-grant", iat: now, jti: id, kind: "AccessToken", scope: "mcp", ...overrides,
    }, 3600);
}
