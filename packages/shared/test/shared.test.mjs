import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

execFileSync("pnpm", ["build"], {
    cwd: new URL("../", import.meta.url),
    stdio: "ignore"
});

const { configSchema, envelopeSchema, errorCodes } = await import(new URL("../dist/index.js", import.meta.url).href);

test("configSchema accepts a valid controller config", () => {
    const result = configSchema.safeParse({
        instances: [
            {
                env: {
                    HOME: "/tmp/demo"
                },
                name: "demo",
                workspacePath: "/workspace/demo"
            }
        ],
        mcp: {
            auth: {
                enabled: true,
                issuer: "https://issuer.example",
                provider: "oidc"
            },
            enabled: true,
            publicExposure: false
        }
    });

    assert.equal(result.success, true);
});

test("configSchema rejects invalid auth and public exposure structure", () => {
    const result = configSchema.safeParse({
        instances: [],
        mcp: {
            auth: {
                enabled: true,
                provider: ""
            },
            enabled: true,
            publicExposure: "yes"
        }
    });

    assert.equal(result.success, false);
});

test("envelopeSchema rejects request envelopes without target", () => {
    const result = envelopeSchema.safeParse({
        id: "req-1",
        issuedAt: "2026-07-07T00:00:00.000Z",
        kind: "request",
        method: "controller.ping"
    });

    assert.equal(result.success, false);
});

test("error codes use domain.reason format", () => {
    for (const code of Object.values(errorCodes)) {
        assert.match(code, /^[a-z]+[a-z_]*\.[a-z]+[a-z_]*$/);
    }
});
