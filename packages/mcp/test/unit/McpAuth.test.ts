import assert from "node:assert/strict";
import test from "node:test";

import { McpAuthMiddleware, McpAuthPublicExposureGuard } from "@portable-devshell/mcp/testing";

test("listenHost=0.0.0.0 plus auth none is rejected", () => {
    const guard = new McpAuthPublicExposureGuard();

    assert.throws(() => {
        guard.assertSafe({
            listenHost: "0.0.0.0",
            auth: { enabled: false, provider: "none" }
        });
    });
});

test("publicBaseUrl outside localhost plus auth none is rejected", () => {
    const guard = new McpAuthPublicExposureGuard();

    assert.throws(() => {
        guard.assertSafe({
            listenHost: "127.0.0.1",
            publicBaseUrl: "https://example.com/mcp",
            auth: { enabled: false, provider: "none" }
        });
    });
});

test("token auth requires bearer header", () => {
    const middleware = new McpAuthMiddleware();
    const response = createResponseDouble();
    const token = "test-token-test-token-test-token-01";

    const authorized = middleware.authorize(
        { headers: { authorization: `Bearer ${token}` } } as never,
        response as never,
        { enabled: true, provider: "token", token }
    );

    assert.equal(authorized, true);
    assert.equal(response.statusCode, undefined);

    const rejected = middleware.authorize(
        { headers: { authorization: "Bearer attacker-token-attacker-token-00" } } as never,
        response as never,
        { enabled: true, provider: "token", token }
    );
    assert.equal(rejected, false);
    assert.equal(response.statusCode, 401);
});

function createResponseDouble() {
    return {
        statusCode: undefined as number | undefined,
        body: "",
        writeHead(statusCode: number) {
            this.statusCode = statusCode;
            return this;
        },
        end(body?: string) {
            this.body = body ?? "";
            return this;
        }
    };
}
