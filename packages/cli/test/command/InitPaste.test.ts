import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    toConfigView,
    Endpoint,
    Stream,
    type CliCommandTransport,
} from "@portable-devshell/shared";
import { executeAccessCommand } from "../../../../extensions/access/src/builtin/AccessCommand.js";
import { createCliCommandAdapter } from "../../src/transport/Command.js";
import { executeInit } from "../../src/command/Init.js";
import type { CliDispatchContext } from "../../src/command/Dispatch.js";

function fixture(stdin: Readable) {
    Object.assign(stdin, { isTTY: true });
    const current = createDefaultControlConfig();
    const saved: unknown[] = [];
    const endpoint = new Endpoint({ host: "test-cli" });
    endpoint.connect = async (host, port) =>
        endpoint.bind(port).connect(host, port);
    const server = new Stream(endpoint.bind("extension", "@control"));
    server.onOpen((stream, name, request: unknown) => {
        void (async () => {
            assert.equal(name, "cliCommandStream");
            try {
                const result = await executeAccessCommand(
                    {
                        async upsert(value: unknown) {
                            saved.push(value);
                            return { state: "running" };
                        },
                    } as never,
                    (request as { argv: string[] }).argv,
                    {
                        localOwner: true,
                        signal: new AbortController().signal,
                        io: {
                            async requestInput(options?: { raw?: boolean }) {
                                await stream.send({
                                    name: "terminal",
                                    payload: { raw: options?.raw === true },
                                });
                            },
                            async writeStderr() {},
                            async writeStdout() {},
                            async readInput() {
                                const next = await stream.readMessage();
                                if (next.type !== "data") return undefined;
                                const message = next.message as {
                                    name?: string;
                                    payload?: { data?: string };
                                } | undefined;
                                if (message?.name === "eof") return undefined;
                                const data = message?.payload?.data;
                                assert.ok(typeof data === "string");
                                return Buffer.from(data, "base64");
                            },
                        },
                    } as never,
                );
                await stream.close(result as never);
            } catch (error) {
                await stream.cancel({ message: (error as Error).message });
            }
        })();
    });
    const cli = createCliCommandAdapter(endpoint, {
        async commands() {
            return [{ id: "access" }];
        },
    } as unknown as CliCommandTransport);
    const context = {
        controlNegotiated: true,
        outputFormat: "text",
        stdin,
        stdout: { write() {} },
        stderr: { write() {} },
        writeValue() {},
        clients: {
            config: {
                async get() {
                    return toConfigView(current);
                },
                async update(request: { mcp: { oauth2: { token: string } } }) {
                    current.mcp.enabled = true;
                    current.mcp.oauth2 = {
                        approval: "token",
                        token: request.mcp.oauth2.token,
                    };
                },
            },
            instance: {
                async createInstance() {
                    current.instances = [
                        normalizeConfigInstanceDraft({
                            name: "local-pc",
                            provider: "local",
                        }),
                    ];
                },
            },
            runtime() {
                return {
                    async start() {
                        return { name: "local-pc", ready: true };
                    },
                };
            },
            cli,
        },
    } as unknown as CliDispatchContext;
    return {
        context,
        saved,
        async run() {
            try {
                return await executeInit({ kind: "init" }, context);
            } finally {
                server.close();
                endpoint.close();
            }
        },
    };
}

for (const chunks of [
    ["3\ngateway\nalice\n22\n127.0.0.1\n17890\n\n"],
    ["3\r", "\ngateway\r\nalice\r\n22\r\n127.0.0.1\r\n17890\r\n\r\n"],
]) {
    test(
        `init delegates all SSH paste answers (${chunks.length} chunks)`,
        { timeout: 2_000 },
        async () => {
            const f = fixture(Readable.from(chunks));
            assert.equal(await f.run(), true);
            assert.deepEqual(f.saved, [
                {
                    enabled: true,
                    host: "gateway",
                    id: "ssh-mcp",
                    port: 22,
                    provider: "ssh",
                    user: "alice",
                    remoteBindHost: "127.0.0.1",
                    remotePort: 17890,
                    target: "mcp",
                },
            ]);
        },
    );
}

test("init reports missing SSH host at EOF", { timeout: 2_000 }, async () => {
    const f = fixture(Readable.from(["3\n"]));
    await assert.rejects(f.run(), /SSH host: is required/u);
    assert.deepEqual(f.saved, []);
});

test("init EOF without selection exits and leaves no line reader listeners", async () => {
    const input = Readable.from([]);
    const f = fixture(input);
    await f.run();
    assert.equal(input.listenerCount("readable"), 0);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.destroyed, true); // Readable auto-destroys on EOF, no explicit close.
});

test(
    "init and delegated SSH leave the same live input usable afterwards",
    { timeout: 2_000 },
    async (t) => {
        const input = new PassThrough();
        t.after(() => input.destroy());
        const f = fixture(input);
        const done = f.run();
        input.write("3\ngateway\nalice\n22\n127.0.0.1\n17890\n\n");
        await done;
        assert.equal(f.saved.length, 1);
        assert.equal(input.destroyed, false);
        assert.equal(input.listenerCount("data"), 0);
        assert.equal(input.listenerCount("end"), 0);
        input.end("next-command\n");
        let remaining = "";
        for await (const chunk of input) remaining += chunk.toString();
        assert.equal(remaining, "next-command\n");
    },
);

test(
    "delegated SSH receives EOF when the original stream has already ended",
    { timeout: 2_000 },
    async () => {
        const input = Readable.from([]);
        for await (const _chunk of input) {
            /* Drain the isolated fixture to EOF. */
        }
        const f = fixture(input);
        try {
            await assert.rejects(
                f.context.clients.cli.command("access", ["ssh"], {
                    relay: {
                        input,
                        stdout: { write() {} },
                        stderr: { write() {} },
                    },
                }),
                /SSH host: is required/u,
            );
        } finally {
            // run() also disposes the fixture's memory Endpoint without any command input.
            await f.run();
        }
    },
);
