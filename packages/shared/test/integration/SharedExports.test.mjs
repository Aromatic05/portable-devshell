import assert from "node:assert/strict";
import test from "node:test";

const { configSchema, errorCodes, validateEvent } = await import("@portable-devshell/shared");

test("configSchema accepts a valid controller config", () => {
    const result = configSchema.safeParse({
        instances: [
            {
                env: { HOME: "/tmp/demo" },
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
            auth: { enabled: true, provider: "" },
            enabled: true,
            publicExposure: "yes"
        }
    });
    assert.equal(result.success, false);
});

test("validateEvent accepts the Event contract and rejects old envelopes", () => {
    assert.deepEqual(validateEvent({
        id: "req-1",
        from: "cli",
        to: "server",
        destination: "@control",
        name: "service.ping"
    }), {
        id: "req-1",
        from: "cli",
        to: "server",
        destination: "@control",
        name: "service.ping"
    });

    assert.throws(() => validateEvent({
        id: "req-1",
        method: "control.ping",
        target: { kind: "control" },
        type: "request"
    }));
});

test("error codes use domain.reason format", () => {
    for (const code of Object.values(errorCodes)) {
        assert.match(code, /^[a-z][A-Za-z_]*\.[a-z][A-Za-z_]*$/);
    }
});
