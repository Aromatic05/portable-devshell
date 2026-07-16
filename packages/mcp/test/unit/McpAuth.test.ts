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

    const authorized = middleware.authorize(
        { headers: { authorization: "Bearer test-token" } } as never,
        response as never,
        { enabled: true, provider: "token" }
    );

    assert.equal(authorized, true);
    assert.equal(response.statusCode, undefined);
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
