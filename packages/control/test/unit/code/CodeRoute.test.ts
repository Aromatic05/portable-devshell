import assert from "node:assert/strict";
import test from "node:test";

import {
    controlErrorCodes,
    type CodeLogEntry,
    type ControlPortContext,
    type JsonValue,
} from "@portable-devshell/shared";

import type { CodeObjectProvider } from "../../../src/code/Api.js";
import { createCodeRouteModule } from "../../../src/code/Route.js";
import { CodeService } from "../../../src/code/Service.js";

function createContext(
    overrides: Partial<ControlPortContext> = {},
): ControlPortContext {
    return {
        afterReply: () => undefined,
        connectionId: "conn-1",
        host: "@control",
        peer: "cli",
        requestId: "req-1",
        signal: new AbortController().signal,
        sourceHost: "cli",
        subject: { id: "local", kind: "local-owner" },
        ...overrides,
    };
}

test("code route enforces CLI peer and local-owner workingDirectory, streams logs, and describes dts", async () => {
    const provider: CodeObjectProvider = {
        describe: () => [
            {
                callable: true,
                id: "instance",
                methods: [
                    {
                        audiences: ["native", "model"],
                        inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                        name: "list",
                        summary: "List instances.",
                    },
                ],
                scopeLevel: "control",
                summary: "Instances.",
            },
        ],
        owns: (id) => id === "instance",
        invoke: async () => [{ name: "demo-local" }],
    };
    const service = new CodeService({ providers: [provider] });
    const module = createCodeRouteModule(service);
    const describeOp = module.operations.find((op) => op.name === "describe")!;
    const evalStream = module.streams!.find((op) => op.name === "eval")!;

    // Non-CLI peer is denied
    assert.throws(
        () =>
            describeOp.handle(
                { id: "1", name: "describe", payload: {} },
                createContext({ peer: "web" }),
            ),
        (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code: unknown }).code === controlErrorCodes.codeAccessDenied,
    );

    // Describe succeeds for CLI
    const described = (await describeOp.handle(
        { id: "2", name: "describe", payload: { target: "instance" } },
        createContext(),
    )) as { dts: string; namespaces: string[] };
    assert.deepEqual(described.namespaces, ["instance"]);
    assert.match(described.dts, /declare namespace devshell\.instance/u);

    // Stream eval emits logs and closes with result
    const logs: CodeLogEntry[] = [];
    let closedValue: JsonValue | undefined;
    let cancelledError: unknown;
    const fakeStream = {
        cancel: async (err: unknown) => {
            cancelledError = err;
        },
        close: async (payload?: JsonValue) => {
            closedValue = payload;
        },
        onCancel: () => () => undefined,
        onClose: () => () => undefined,
        onData: () => () => undefined,
        send: async (msg: { name: string; payload?: JsonValue }) => {
            if (msg.name === "log") logs.push(msg.payload as unknown as CodeLogEntry);
        },
    };
    await evalStream.handle(
        fakeStream as never,
        {
            id: "3",
            name: "eval",
            payload: {
                source: 'console.log("hi"); await devshell.instance.list()',
            },
        },
        createContext(),
    );
    assert.equal(cancelledError, undefined);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.text, "hi");
    assert.deepEqual((closedValue as { value: unknown }).value, [
        { name: "demo-local" },
    ]);
});
