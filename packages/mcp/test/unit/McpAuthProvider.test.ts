import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    McpAuthMiddleware,
    McpAuthProviderNone,
    McpAuthProviderToken
} from "@portable-devshell/mcp/testing";

test("none auth provider always authorizes", () => {
    assert.equal(new McpAuthProviderNone().authorize(), true);
});

test("token auth provider accepts a single case-insensitive Bearer credential and hashes its client id", () => {
    const provider = new McpAuthProviderToken();
    const expectedClientId = `token:${createHash("sha256").update("secret-token").digest("hex")}`;

    assert.deepEqual(provider.authenticate("Bearer secret-token"), {
        clientId: expectedClientId,
        scopes: [],
        token: "secret-token"
    });
    assert.deepEqual(provider.authenticate("bearer secret-token"), {
        clientId: expectedClientId,
        scopes: [],
        token: "secret-token"
    });
    assert.equal(provider.authorize("BEARER secret-token"), true);
});

test("token auth provider rejects missing, empty, wrong-scheme, and multi-token headers", () => {
    const provider = new McpAuthProviderToken();

    for (const header of [
        undefined,
        "",
        "Bearer",
        "Bearer ",
        "Basic secret-token",
        "Bearer first second",
        "Bearer first\tsecond"
    ]) {
        assert.equal(provider.authenticate(header), undefined);
        assert.equal(provider.authorize(header), false);
    }
});

test("auth middleware bypasses disabled auth without writing a response", () => {
    const middleware = new McpAuthMiddleware();

    for (const config of [undefined, { enabled: false, provider: "none" } as const]) {
        const response = createResponseDouble();
        assert.equal(
            middleware.authorize({ headers: {} } as never, response as never, config),
            true
        );
        assert.equal(response.statusCode, undefined);
        assert.equal(response.body, "");
    }
});

test("auth middleware returns a JSON 401 for an invalid token", () => {
    const middleware = new McpAuthMiddleware();
    const response = createResponseDouble();

    assert.equal(
        middleware.authorize(
            { headers: { authorization: "Basic invalid" } } as never,
            response as never,
            { enabled: true, provider: "token" }
        ),
        false
    );
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, { "content-type": "application/json" });
    assert.equal(response.body, '{"error":"Unauthorized"}');
});

test("auth middleware returns a JSON 501 for an unsupported enabled provider", () => {
    const middleware = new McpAuthMiddleware();
    const response = createResponseDouble();

    assert.equal(
        middleware.authorize(
            { headers: {} } as never,
            response as never,
            { enabled: true, provider: "oauth" } as never
        ),
        false
    );
    assert.equal(response.statusCode, 501);
    assert.deepEqual(response.headers, { "content-type": "application/json" });
    assert.equal(response.body, '{"error":"Unsupported auth provider"}');
});

function createResponseDouble() {
    return {
        body: "",
        headers: undefined as Record<string, string> | undefined,
        statusCode: undefined as number | undefined,
        writeHead(statusCode: number, headers: Record<string, string>) {
            this.statusCode = statusCode;
            this.headers = headers;
            return this;
        },
        end(body?: string) {
            this.body = body ?? "";
            return this;
        }
    };
}
