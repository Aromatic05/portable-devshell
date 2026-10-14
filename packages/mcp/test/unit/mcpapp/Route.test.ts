import assert from "node:assert/strict";
import test from "node:test";
import { Endpoint } from "@portable-devshell/shared";
import type { McpHttpRoute } from "../../../src/server/Api.ts";
import { McpAppRoute } from "../../../src/mcpapp/Route.ts";
import { McpAppRuntime } from "../../../src/mcpapp/index.ts";

function faultingHost(failAt?: number) {
    const routes = new Map<symbol, string>();
    let calls = 0;
    const install = (kind: string, path: string) => {
        calls++;
        if (calls === failAt) throw new Error(`Cannot install ${kind}:${path}`);
        const id = Symbol();
        routes.set(id, `${kind}:${path}`);
        return () => { routes.delete(id); };
    };
    return {
        http: {
            registerMiddleware: (path: string) => install("middleware", path),
            registerStaticDirectory: (path: string) => install("static", path),
            registerRawRoute: (method: string, path: string) => install(method, path),
        } as unknown as McpHttpRoute,
        routes: () => [...routes.values()].sort(),
    };
}

const contexts = {
    async validateForInstance() { throw new Error("Unexpected Context validation"); },
};

function runtime() {
    return new McpAppRuntime({ endpoint: new Endpoint({ host: "mcpapp-route-failure-test" }) });
}

test("MCP App constructor undoes CORS middleware if static mounting fails", () => {
    const port = faultingHost(2);
    assert.throws(() => new McpAppRoute(port.http, runtime(), contexts), /Cannot install static/u);
    assert.deepEqual(port.routes(), []);
});

test("each Live registration stage rolls back prior routes and keeps other instances intact", () => {
    for (const failAt of [3, 4, 5, 6, 7, 8, 9, 10]) {
        const port = faultingHost(failAt);
        const route = new McpAppRoute(port.http, runtime(), contexts, "https://example.test/prefix");
        const initial = port.routes();
        assert.deepEqual(initial, ["middleware:/prefix/mcpapp/assets", "static:/prefix/mcpapp/assets"]);
        assert.throws(() => route.register("demo"), /Cannot install/u);
        assert.equal(route.has("demo"), false);
        assert.deepEqual(port.routes(), initial);
        route.close();
        assert.deepEqual(port.routes(), []);
    }
});

test("MCP App closes all installed assets and Live routes and remains idempotent", () => {
    const port = faultingHost();
    const route = new McpAppRoute(port.http, runtime(), contexts, "https://example.test/prefix/");
    route.register("first");
    route.register("second");
    assert.equal(port.routes().length, 18);
    assert.equal(port.routes().filter((name) => name.includes("/activity")).length, 4);
    assert.equal(port.routes().filter((name) => name.includes("/image")).length, 4);
    route.unregister("first");
    assert.equal(port.routes().length, 10);
    route.close();
    route.close();
    assert.deepEqual(port.routes(), []);
});
