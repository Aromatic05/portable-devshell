import assert from "node:assert/strict";
import test from "node:test";

import type { McpAuthConfig } from "../../../../src/oauth/Config.ts";
import type { McpOAuthProtectedResource } from "../../../../src/oauth/Route.ts";
import { McpEndpointBinding } from "../../../../src/protocol/Binding.ts";
import { McpProtocolRoute } from "../../../../src/protocol/Route.ts";
import type { McpHostRouteEntry } from "../../../../src/protocol/Registry.ts";
import type { McpHttpRoute } from "../../../../src/server/Api.ts";
import { createTestMcpEndpoint } from "../../../ContextRuntime.ts";

function makeEntry(name: string, path: string, auth: McpAuthConfig = { enabled: false, provider: "none" }): McpHostRouteEntry {
    return {
        auth,
        binding: new McpEndpointBinding(createTestMcpEndpoint({ instanceName: name })),
        path,
    };
}

function recordingHttp() {
    const entries = new Map<symbol, string>();
    let failPath: string | undefined;
    const install = (path: string) => {
        if (path === failPath) throw new Error(`HTTP registration failed: ${path}`);
        const id = Symbol(path);
        entries.set(id, path);
        return () => { entries.delete(id); };
    };
    const http = {
        registerMiddleware: (path: string) => install(path),
        registerRawRoute: (_method: string, path: string) => install(path),
    } as unknown as McpHttpRoute;
    return {
        http,
        paths: () => [...entries.values()].sort(),
        reject: (path?: string) => { failPath = path; },
    };
}

test("Protocol live replacement is atomic when the new middleware fails to mount", () => {
    const port = recordingHttp();
    const protocol = new McpProtocolRoute(port.http);
    const original = makeEntry("demo", "/ok");
    protocol.register(original);
    protocol.start();
    assert.deepEqual(port.paths(), ["/ok"]);

    const failed = makeEntry("demo", "/fail");
    port.reject("/fail");
    assert.throws(() => protocol.register(failed), /HTTP registration failed: \/fail/u);
    assert.equal(protocol.list()[0]?.binding, original.binding);
    assert.deepEqual(port.paths(), ["/ok"]);

    port.reject();
    const replaced = makeEntry("demo", "/new");
    protocol.register(replaced);
    assert.equal(protocol.list()[0]?.binding, replaced.binding);
    assert.deepEqual(port.paths(), ["/new"]);

    const samePath = makeEntry("demo", "/new");
    protocol.register(samePath);
    assert.equal(protocol.list()[0]?.binding, samePath.binding);
    assert.deepEqual(port.paths(), ["/new"]);
    protocol.stop();
    assert.deepEqual(port.paths(), []);
});

test("Protocol startup rolls back every mounted route when a later mount fails", () => {
    const port = recordingHttp();
    const protocol = new McpProtocolRoute(port.http);
    protocol.register(makeEntry("first", "/first"));
    protocol.register(makeEntry("second", "/second"));
    port.reject("/second");
    assert.throws(() => protocol.start(), /HTTP registration failed/u);
    assert.deepEqual(port.paths(), []);
    assert.deepEqual(protocol.list().map((entry) => entry.path), ["/first", "/second"]);
    port.reject();
    protocol.start();
    assert.deepEqual(port.paths(), ["/first", "/second"]);
    protocol.stop();
    assert.deepEqual(port.paths(), []);
});

test("failed OAuth middleware or metadata registration releases the new Resource without dropping the old", () => {
    const port = recordingHttp();
    const resources = new Map<string, number>();
    const oauth = {
        registerResource(url: URL) {
            resources.set(url.href, (resources.get(url.href) ?? 0) + 1);
            return () => {
                const remaining = (resources.get(url.href) ?? 0) - 1;
                if (remaining > 0) resources.set(url.href, remaining);
                else resources.delete(url.href);
            };
        },
        protectedResourceMetadata() { return { authorization_servers: [] }; },
        requestAuthHandler() { return (_req: unknown, _res: unknown, next: () => void) => next(); },
    } as unknown as McpOAuthProtectedResource;
    const auth: McpAuthConfig = {
        enabled: true,
        provider: "oauth2",
        oauth2: { requiredScopes: ["mcp"], resourceName: "demo" },
    };
    const protocol = new McpProtocolRoute(port.http, {
        oauth, publicBaseUrl: "https://controller.example/old",
    });
    const original = makeEntry("demo", "/ok", auth);
    protocol.register(original);
    protocol.start();
    assert.deepEqual([...resources.keys()], ["https://controller.example/old/ok"]);

    for (const failingPath of [
        "/.well-known/oauth-protected-resource/old/fail",
        "/fail",
    ]) {
        port.reject(failingPath);
        assert.throws(() => protocol.register(makeEntry("demo", "/fail", auth)), /HTTP registration failed/u);
        assert.equal(protocol.list()[0]?.binding, original.binding);
        assert.deepEqual([...resources.keys()], ["https://controller.example/old/ok"]);
        assert.deepEqual(port.paths(), ["/.well-known/oauth-protected-resource/old/ok", "/ok"]);
    }
    protocol.stop();
    assert.deepEqual([...resources.keys()], []);
    assert.deepEqual(port.paths(), []);
});
