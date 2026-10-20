import assert from "node:assert/strict";
import type { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";
import { Round4MemoryHttp } from "../integration/AuthTransportRound4MemoryHttp.ts";

export interface OAuthJwksEvidence {
    jwks: { keys: Array<Record<string, unknown>> };
    signature: string;
    clientId: string;
}

export async function oauthJwksEvidence(runtime: McpOAuthProviderRuntime): Promise<OAuthJwksEvidence> {
    const http = new Round4MemoryHttp();
    http.registerMiddleware("/", (request, response) => { runtime.provider.callback()(request, response); });
    const response = await http.fetch(new URL("/jwks", runtime.issuerUrl));
    assert.equal(response.status, 200);
    const jwks = await response.json() as OAuthJwksEvidence["jwks"];
    const clientId = await runtime.registerFirstPartyWebClient("http://mcp.example.test/jwks-callback", ["mcp"]);
    const client = await runtime.provider.Client.find(clientId);
    assert.ok(client);
    const token = new runtime.provider.IdToken({ sub: runtime.accountId }, { client });
    const signature = await token.issue({ use: "idtoken" });
    return { jwks, signature, clientId };
}
