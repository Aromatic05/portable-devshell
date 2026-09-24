import assert from "node:assert/strict";
import test from "node:test";

import { executeOAuthCommand } from "../../src/command/control/OAuth.js";
import { CliParser } from "../../src/command/Parse.js";
import type { CliDispatchContext } from "../../src/command/Dispatch.js";

test("CLI parses OAuth approval management commands", () => {
    const parser = new CliParser();
    assert.deepEqual(parser.parse(["oauth", "approval"]), {
        kind: "oauth.approval.status",
    });
    assert.deepEqual(parser.parse(["oauth", "approval", "status"]), {
        kind: "oauth.approval.status",
    });
    assert.deepEqual(parser.parse(["oauth", "approval", "tui"]), {
        kind: "oauth.approval.tui",
    });
    assert.deepEqual(parser.parse(["oauth", "approval", "token"]), {
        kind: "oauth.approval.token",
    });
    assert.deepEqual(parser.parse(["oauth", "approval", "rotate"]), {
        kind: "oauth.approval.rotate",
    });
});

test("CLI manages OAuth approval mode and rotates token", async () => {
    const updates: unknown[] = [];
    const writes: Array<{ value: unknown; text: string }> = [];
    let oauth2: { approval: "token" | "tui"; token?: string } = {
        approval: "tui",
    };
    const context = {
        clients: {
            config: {
                async get() {
                    return {
                        mcp: {
                            enabled: true,
                            listenHost: "127.0.0.1",
                            listenPort: 17890,
                            oauth2,
                            publicBaseUrl: "https://example.test/",
                        },
                    };
                },
                async update(request: unknown) {
                    updates.push(request);
                    const next = request as {
                        mcp?: {
                            oauth2?: {
                                approval?: "token" | "tui";
                                token?: string;
                            };
                        };
                    };
                    if (next.mcp?.oauth2?.approval === "tui") {
                        oauth2 = { approval: "tui" };
                    } else if (next.mcp?.oauth2?.approval === "token") {
                        oauth2 = {
                            approval: "token",
                            ...(next.mcp.oauth2.token === undefined
                                ? oauth2.approval === "token" && oauth2.token !== undefined
                                    ? { token: oauth2.token }
                                    : {}
                                : { token: next.mcp.oauth2.token }),
                        };
                    }
                    return {};
                },
            },
        },
        writeValue(value: unknown, text: string) {
            writes.push({ value, text });
        },
    } as unknown as CliDispatchContext;

    await executeOAuthCommand({ kind: "oauth.approval.status" }, context);
    assert.deepEqual(writes.at(-1)?.value, {
        mode: "tui",
        tokenConfigured: false,
    });

    await executeOAuthCommand({ kind: "oauth.approval.token" }, context);
    const firstToken = oauth2.approval === "token" ? oauth2.token : undefined;
    assert.match(firstToken ?? "", /^ds_[0-9a-f]{64}$/u);
    assert.equal(updates.length, 1);
    assert.match(writes.at(-1)?.text ?? "", /Save this token now/u);

    await executeOAuthCommand({ kind: "oauth.approval.token" }, context);
    assert.equal(updates.length, 1, "re-enabling configured token mode must not rotate");

    await executeOAuthCommand({ kind: "oauth.approval.rotate" }, context);
    const rotatedToken = oauth2.approval === "token" ? oauth2.token : undefined;
    assert.match(rotatedToken ?? "", /^ds_[0-9a-f]{64}$/u);
    assert.notEqual(rotatedToken, firstToken);
    assert.equal(updates.length, 2);

    await executeOAuthCommand({ kind: "oauth.approval.tui" }, context);
    assert.deepEqual(oauth2, { approval: "tui" });
    assert.equal(updates.length, 3);
});
