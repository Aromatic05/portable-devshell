import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionConfig, ExtensionJsonValue } from "@portable-devshell/extension";

import { parseAccessConfig } from "../../src/builtin/Config.ts";
import { resolveAccessTarget } from "../../src/builtin/Target.ts";

test("Access Config parses provider-specific endpoints and defaults", () => {
    const config = parseAccessConfig({
        endpoints: [
            {
                enabled: true,
                id: "quick",
                provider: "cloudflared",
                target: "web",
            },
            {
                enabled: true,
                id: "frp-main",
                provider: "frp",
                publicUrl: "https://edge.example.test:8443",
                remotePort: 8443,
                serverHost: "frp.example.test",
                target: "mcp",
            },
            {
                enabled: false,
                host: "gateway.example.test",
                id: "ssh-main",
                provider: "ssh",
                remotePort: 9443,
                target: "web",
            },
        ],
    });

    assert.equal(config.endpoints[1]?.provider, "frp");
    if (config.endpoints[1]?.provider !== "frp") assert.fail("FRP endpoint expected");
    assert.equal(config.endpoints[1].serverPort, 7000);
    assert.equal(config.endpoints[1].publicUrl, "https://edge.example.test:8443/");
    if (config.endpoints[2]?.provider !== "ssh") assert.fail("SSH endpoint expected");
    assert.equal(config.endpoints[2].port, 22);
    assert.equal(config.endpoints[2].remoteBindHost, "127.0.0.1");
});

test("Access Config rejects duplicate ids and non-HTTP public URLs", () => {
    const endpoint = {
        enabled: true,
        id: "same",
        provider: "cloudflared",
        target: "mcp",
    } as const;
    assert.throws(
        () => parseAccessConfig({ endpoints: [endpoint, endpoint] }),
        /ids must be unique/u,
    );
    assert.throws(
        () =>
            parseAccessConfig({
                endpoints: [
                    {
                        enabled: true,
                        host: "gateway.example.test",
                        id: "bad-url",
                        provider: "ssh",
                        publicUrl: "javascript:alert(1)",
                        remotePort: 9000,
                        target: "web",
                    },
                ],
            }),
        /must use http or https/u,
    );
});

test("Access target resolution maps wildcard listeners to loopback", async () => {
    const values = new Map<string, ExtensionJsonValue>([
        ["mcp.enabled", true],
        ["mcp.listenHost", "0.0.0.0"],
        ["mcp.listenPort", 47123],
        ["mcp.publicBaseUrl", "https://public.example.test/base"],
        ["web.enabled", false],
        ["web.listenHost", "::"],
        ["web.listenPort", 47124],
        ["web.publicBaseUrl", "https://web.example.test"],
    ]);
    const config: ExtensionConfig = {
        async get(path) {
            return values.get(path);
        },
        onChange() {
            return () => undefined;
        },
        async update() {},
    };

    const mcp = await resolveAccessTarget(config, "mcp");
    assert.equal(mcp.available, true);
    if (!mcp.available) assert.fail("MCP target should be available");
    assert.equal(mcp.target.origin.href, "http://127.0.0.1:47123/");
    assert.equal(mcp.target.publicBaseUrl, "https://public.example.test/base");

    assert.deepEqual(await resolveAccessTarget(config, "web"), {
        available: false,
        reason: "WEB endpoint is disabled.",
    });
});

test("Access target resolution waits on dynamic Core listen ports", async () => {
    const values = new Map<string, ExtensionJsonValue>([
        ["mcp.enabled", true],
        ["mcp.listenHost", "127.0.0.1"],
        ["mcp.listenPort", 0],
        ["mcp.publicBaseUrl", "http://127.0.0.1:0"],
    ]);
    const config: ExtensionConfig = {
        async get(path) {
            return values.get(path);
        },
        onChange() {
            return () => undefined;
        },
        async update() {},
    };

    assert.deepEqual(await resolveAccessTarget(config, "mcp"), {
        available: false,
        reason: "MCP endpoint uses dynamic listenPort 0; Access requires an explicit listen port.",
    });
});
