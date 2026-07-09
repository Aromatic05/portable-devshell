import assert from "node:assert/strict";
import test from "node:test";

const { configSchema, envelopeSchema, errorCodes } = await import("@portable-devshell/shared");

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

test("envelopeSchema accepts request envelopes with type and target.kind", () => {
    const result = envelopeSchema.safeParse({
        id: "req-1",
        method: "control.ping",
        target: {
            kind: "control"
        },
        type: "request"
    });

    assert.equal(result.success, true);
});

test("envelopeSchema rejects legacy envelope fields", () => {
    const legacyKind = envelopeSchema.safeParse({
        id: "req-1",
        kind: "request",
        method: "control.ping",
        target: {
            kind: "control"
        }
    });
    const legacyTarget = envelopeSchema.safeParse({
        id: "req-2",
        method: "control.ping",
        target: {
            type: "controller"
        },
        type: "request"
    });
    const legacyIssuedAt = envelopeSchema.safeParse({
        id: "req-3",
        issuedAt: "2026-07-07T00:00:00.000Z",
        method: "control.ping",
        target: {
            kind: "control"
        },
        type: "request"
    });

    assert.equal(legacyKind.success, false);
    assert.equal(legacyTarget.success, false);
    assert.equal(legacyIssuedAt.success, false);
});

test("error codes use domain.reason format", () => {
    for (const code of Object.values(errorCodes)) {
        assert.match(code, /^[a-z][A-Za-z_]*\.[a-z][A-Za-z_]*$/);
    }
});
