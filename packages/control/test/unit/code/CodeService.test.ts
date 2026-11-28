import assert from "node:assert/strict";
import test from "node:test";

import type { CodeLogEntry, JsonValue } from "@portable-devshell/shared";

import type {
    CodeExecutionPrincipal,
    CodeMethodInvocationContext,
    CodeObjectDescriptor,
    CodeObjectProvider,
} from "../../../src/code/Api.js";
import { CodeService } from "../../../src/code/Service.js";

function createTestPrincipal(
    overrides: Partial<CodeExecutionPrincipal> = {},
): CodeExecutionPrincipal {
    return {
        audience: "native",
        localOwner: true,
        requestId: "req-test",
        ...overrides,
    };
}

function createMockProviders() {
    const invocations: Array<{
        input: JsonValue;
        instance?: string;
        method: string;
        objectId: string;
        parentCallId: string;
        workspace?: string;
    }> = [];
    const closedHandles: string[] = [];

    const descriptors: CodeObjectDescriptor[] = [
        {
            callable: true,
            id: "instance",
            methods: [
                {
                    audiences: ["native", "model"],
                    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                    name: "list",
                    outputSchema: {
                        items: {
                            properties: { name: { type: "string" } },
                            required: ["name"],
                            type: "object",
                        },
                        type: "array",
                    },
                    summary: "List instances.",
                },
            ],
            scopeLevel: "control",
            summary: "Instance lifecycle and handle factory.",
        },
        {
            id: "bash",
            methods: [
                {
                    audiences: ["native", "model"],
                    inputSchema: {
                        additionalProperties: false,
                        properties: {
                            command: { type: "string" },
                            delayMs: { type: "integer" },
                        },
                        required: ["command"],
                        type: "object",
                    },
                    name: "run",
                    outputSchema: {
                        properties: {
                            exitCode: { type: "number" },
                            stdout: { type: "string" },
                        },
                        required: ["exitCode", "stdout"],
                        type: "object",
                    },
                    summary: "Run a shell command.",
                },
            ],
            scopeLevel: "instance",
            summary: "Shell command execution.",
        },
        {
            id: "file",
            methods: [
                {
                    audiences: ["native", "model"],
                    inputSchema: {
                        additionalProperties: false,
                        properties: {
                            patterns: { items: { type: "string" }, type: "array" },
                        },
                        required: ["patterns"],
                        type: "object",
                    },
                    name: "glob",
                    summary: "Glob workspace files.",
                },
            ],
            scopeLevel: "instance",
            summary: "Workspace file tools.",
        },
        {
            callable: true,
            id: "session",
            methods: [
                {
                    audiences: ["native", "model"],
                    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                    name: "list",
                    summary: "List sessions.",
                },
            ],
            scopeLevel: "control",
            summary: "Scoped handle test object.",
        },
    ];

    const provider: CodeObjectProvider = {
        describe: (principal) =>
            descriptors.map((desc) => ({
                ...desc,
                methods: desc.methods.filter((m) =>
                    m.audiences.includes(principal.audience),
                ),
            })),
        owns: (objectId) => descriptors.some((desc) => desc.id === objectId),
        invoke: async (
            objectId: string,
            method: string,
            input: JsonValue,
            context: CodeMethodInvocationContext,
        ): Promise<JsonValue> => {
            invocations.push({
                input,
                ...(context.instance === undefined ? {} : { instance: context.instance }),
                method,
                objectId,
                parentCallId: context.parentCallId,
                ...(context.workspace === undefined ? {} : { workspace: context.workspace }),
            });
            if (objectId === "instance" && method === "list") {
                return [{ name: "alpha-local" }, { name: "beta-ssh" }];
            }
            if (objectId === "bash" && method === "run") {
                const rec = input as { command: string; delayMs?: number };
                if (rec.delayMs !== undefined) {
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, rec.delayMs);
                        context.signal.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(timer);
                                reject(new Error("aborted"));
                            },
                            { once: true },
                        );
                    });
                }
                return {
                    exitCode: 0,
                    stdout: `${context.instance}:${context.workspace}:${rec.command}`,
                };
            }
            if (objectId === "file" && method === "glob") {
                const rec = input as { patterns: string[] };
                return { files: rec.patterns.map((p) => `${context.workspace}/${p}`) };
            }
            return { ok: true };
        },
        openHandle: async (_objectId, target) => `handle:${JSON.stringify(target)}`,
        invokeHandle: async (_objectId, handleId, method, input) => ({
            handleId,
            input,
            method,
        }),
        closeHandle: async (_objectId, handleId) => {
            closedHandles.push(handleId);
        },
    };

    return { closedHandles, invocations, provider };
}

test("CodeService evaluates completion values, top-level return, and console logs", async () => {
    const { provider } = createMockProviders();
    const service = new CodeService({ providers: [provider] });

    // Single expression auto-return without explicit `return`
    const expr = await service.eval(
        { source: "await devshell.instance.list()" },
        { principal: createTestPrincipal() },
    );
    assert.equal(expr.hasValue, true);
    assert.deepEqual(expr.value, [{ name: "alpha-local" }, { name: "beta-ssh" }]);
    assert.equal(expr.meta.toolCalls, 1);

    // Multi-statement with completion value
    const multi = await service.eval(
        { source: "const list = await devshell.instance.list(); list.length" },
        { principal: createTestPrincipal() },
    );
    assert.equal(multi.hasValue, true);
    assert.equal(multi.value, 2);

    // Explicit top-level return + streaming logs
    const streamed: CodeLogEntry[] = [];
    const withReturn = await service.eval(
        {
            source: [
                'console.log("step", 1);',
                'console.warn("careful");',
                "const list = await devshell.instance.list();",
                "return { count: list.length };",
            ].join("\n"),
        },
        {
            onLog: (entry) => streamed.push(entry),
            principal: createTestPrincipal(),
        },
    );
    assert.deepEqual(withReturn.value, { count: 2 });
    assert.equal(streamed.length, 2);
    assert.equal(streamed[0]?.text, "step 1");
    assert.equal(streamed[1]?.level, "warn");
});

test("CodeService supports Promise.all concurrency and multi-instance handles", async () => {
    const { invocations, provider } = createMockProviders();
    const service = new CodeService({ providers: [provider] });

    const result = await service.eval(
        {
            instance: "alpha-local",
            source: `
                const beta = devshell.instance({ name: "beta-ssh", workspace: "/srv/beta" });
                const altAlpha = devshell.withWorkspace("/repo/sub");
                const [a, b, c, files] = await Promise.all([
                    devshell.bash.run({ command: "pwd", delayMs: 25 }),
                    beta.bash.run({ command: "uname", delayMs: 25 }),
                    altAlpha.bash.run({ command: "id", delayMs: 25 }),
                    devshell.file.glob({ patterns: ["src/**/*.rs"] }),
                ]);
                return { a: a.stdout, b: b.stdout, c: c.stdout, files };
            `,
            workspace: "/repo",
        },
        { principal: createTestPrincipal() },
    );

    assert.deepEqual(result.value, {
        a: "alpha-local:/repo:pwd",
        b: "beta-ssh:/srv/beta:uname",
        c: "alpha-local:/repo/sub:id",
        files: { files: ["/repo/src/**/*.rs"] },
    });
    assert.equal(invocations.length, 4);
    assert.ok(invocations.every((call) => call.parentCallId === result.meta.callId));
});

test("CodeService enforces sandbox isolation, infinite-loop timeout, and AbortSignal cancellation", async () => {
    const { provider } = createMockProviders();
    const service = new CodeService({
        limits: { maxMemoryBytes: 16 * 1024 * 1024 },
        providers: [provider],
    });

    const isolation = await service.eval(
        {
            source: `({
                hasProcess: typeof process !== "undefined",
                hasRequire: typeof require !== "undefined",
                hasHost: typeof __devshell_host__ !== "undefined",
            })`,
        },
        { principal: createTestPrincipal() },
    );
    assert.deepEqual(isolation.value, {
        hasHost: false,
        hasProcess: false,
        hasRequire: false,
    });

    // Hard interrupt synchronous infinite loop
    await assert.rejects(
        service.eval(
            { source: "while (true) {}", timeoutMs: 80 },
            { principal: createTestPrincipal() },
        ),
        /timed out/u,
    );

    // AbortSignal cancellation mid-flight
    const controller = new AbortController();
    const pending = service.eval(
        {
            instance: "alpha-local",
            source: 'await devshell.bash.run({ command: "slow", delayMs: 5000 })',
            workspace: "/repo",
        },
        { principal: createTestPrincipal(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("stop now")), 25);
    await assert.rejects(pending, /cancelled/u);
});

test("CodeService produces self-healing Proxy/schema errors, .d.ts help, and closes scoped handles", async () => {
    const { closedHandles, provider } = createMockProviders();
    const service = new CodeService({ providers: [provider] });

    // Unknown method on namespace lists available signatures
    await assert.rejects(
        service.eval(
            { instance: "alpha-local", source: "devshell.file.find({})", workspace: "/repo" },
            { principal: createTestPrincipal() },
        ),
        /Unknown method: devshell\.file\.find[\s\S]*glob\(/u,
    );

    // Schema validation error shows exact .d.ts signature
    await assert.rejects(
        service.eval(
            {
                instance: "alpha-local",
                source: 'await devshell.bash.run({ cmd: "ls" })',
                workspace: "/repo",
            },
            { principal: createTestPrincipal() },
        ),
        /missing required "command"[\s\S]*unexpected key "cmd"[\s\S]*Signature:[\s\S]*devshell\.bash\.run\(/u,
    );

    // Unbound instance guidance error
    await assert.rejects(
        service.eval(
            { source: 'await devshell.bash.run({ command: "ls" })' },
            { principal: createTestPrincipal() },
        ),
        /No active instance\/workspace is bound/u,
    );

    // Runtime help() and describe() emit compact .d.ts
    const helpResult = await service.eval(
        { source: 'devshell.help("bash")' },
        { principal: createTestPrincipal() },
    );
    assert.match(String(helpResult.value), /declare namespace devshell\.bash/u);
    assert.match(String(helpResult.value), /run\(input: \{ command: string/u);

    const described = service.describe({}, createTestPrincipal());
    assert.ok(described.namespaces.includes("instance"));
    assert.match(described.dts, /interface DevShellRoot extends InstanceHandle/u);

    // Scoped handle opens, invokes, and is forcibly closed when evaluation finishes
    const handleResult = await service.eval(
        {
            source: `
                const s = devshell.session("github");
                return await s.ping({ hello: "world" });
            `,
        },
        { principal: createTestPrincipal() },
    );
    assert.deepEqual(handleResult.value, {
        handleId: 'handle:"github"',
        input: { hello: "world" },
        method: "ping",
    });
    assert.deepEqual(closedHandles, ['handle:"github"']);
});
