import assert from "node:assert/strict";
import test from "node:test";
import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    type ExtensionManifest,
    type ExtensionPointDeclaration,
} from "@portable-devshell/extension";
import { ExtensionHost } from "../../../src/extension/host/index.ts";
import { ExtensionGeneration } from "../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../src/extension/registration/Registration.ts";
import { createControlExtensionPointRegistry } from "../../../src/extension/registration/Points.ts";
import { deferred } from "./Round3Harness.ts";

function manifest(id: string): ExtensionManifest {
    return {
        activation: "lazy",
        apiVersion: EXTENSION_API_VERSION,
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        capabilities: [],
        entry: "extension.mjs",
        hostDependencies: {},
        id,
        name: id,
        version: "1.0.0",
        extensions: {
            "cli.native-commands": [{ id: "shared", title: "Shared" }],
        },
    };
}

test("queued admission rejects a foreign owner and permits semantic reload", async (t) => {
    const loading = deferred();
    const resume = deferred();
    const host = new ExtensionHost({
        registry: {
            read: async () => ({
                schemaVersion: 1,
                extensions: {
                    first: { enabled: true, selectedGeneration: "g1" },
                },
            }),
            write: async () => {},
        },
        loader: {
            points: createControlExtensionPointRegistry(),
            readManifest: async (id) => manifest(id),
            load: async (id, generation) => {
                loading.resolve();
                await resume.promise;
                return new ExtensionGeneration({
                    generation,
                    manifest: manifest(id),
                    dispose: async () => {},
                    registrations: new ExtensionRegistrationSet([
                        {
                            pointId: "cli.native-commands",
                            id: "shared",
                            declaration: { title: "Shared", id: "shared" },
                            binding: async () => id,
                        },
                    ]),
                });
            },
        },
    });
    await host.start();
    t.after(async () => {
        resume.resolve();
        await host.stop();
    });
    const reload = host.activateGeneration("first", "g2");
    await loading.promise;
    const disabled = host.disable("first");
    const replaced = host.activateGeneration("second", "g1");
    const pending = host.acquireRegistration("cli.native-commands", "shared");
    const rejected = assert.rejects(
        pending.then((lease) => {
            lease.lease.release();
        }),
        /declaration changed/,
    );
    resume.resolve();
    await Promise.all([reload, disabled, replaced, rejected]);
    const fresh = await host.acquireRegistration(
        "cli.native-commands",
        "shared",
    );
    assert.equal(fresh.extensionId, "second");
    fresh.lease.release();
});

test("failed validation candidate remains owned until drain retry", async () => {
    let attempts = 0;
    let healthy = false;
    const failure = new Error("candidate dispose failed");
    const candidate = new ExtensionGeneration({
        generation: "g1",
        manifest: manifest("first"),
        registrations: new ExtensionRegistrationSet([]),
        dispose: async () => {
            attempts++;
            assert.equal(healthy, true, failure.message);
        },
    });
    const host = new ExtensionHost({
        registry: {
            read: async () => ({
                schemaVersion: 1,
                extensions: {
                    first: { enabled: false, selectedGeneration: "g1" },
                },
            }),
            write: async () => {},
        },
        loader: {
            points: createControlExtensionPointRegistry(),
            readManifest: async () => manifest("first"),
            load: async () => candidate,
        },
    });
    await host.start();
    await assert.rejects(
        host.selectGeneration("first", "g1"),
        /candidate dispose failed/,
    );
    await assert.rejects(host.waitForDrain("first"), /failed to drain/);
    await assert.rejects(host.forget("first"), /draining/);
    assert.equal(attempts, 2);
    healthy = true;
    await host.waitForDrain("first");
    assert.equal(candidate.state, "disposed");
    assert.equal(attempts, 3);
    await host.forget("first");
    await host.stop();
});

import { CliExtensionCommandService } from "../../../src/extension/api/point/cli/command/Service.ts";
import { McpExtensionService } from "../../../src/extension/api/point/mcp/index.ts";
import { TuiExtensionPageService } from "../../../src/extension/api/point/tui/Service.ts";
import { WebExtensionPageService } from "../../../src/server/web/extension/page/Service.ts";
import { ToolCallExtensionBinding } from "../../../src/extension/api/point/toolcall/index.ts";
import { resolveExecutionDrivers } from "../../../src/extension/api/point/execution/index.ts";

const declarations = {
    "cli.native-commands": { id: "shared", title: "Shared" },
    "cli.model-commands": { id: "shared", title: "Shared" },
    "mcp.tools": {
        id: "shared_tool",
        description: "Shared",
        inputSchema: {},
        outputSchema: {},
    },
    "tui.pages": { id: "shared", title: "Shared" },
    "web.pages": { id: "shared", title: "Shared" },
    "toolcall.review": { id: "shared", hook: "100-shared" },
    "toolcall.rewrite": { id: "shared", hook: "100-shared" },
    "execution.environment": { id: "shared" },
    "execution.sandbox": { id: "shared" },
};

for (const pointId of Object.keys(declarations))
    for (const mode of ["foreign", "same", "changed"] as const) {
        test(`${pointId} production adapter queued ${mode} admission`, async (t) => {
            const loading = deferred();
            const resume = deferred();
            const calls: string[] = [];
            const originalDeclaration =
                declarations[pointId as keyof typeof declarations];
            const changed = pointId.startsWith("toolcall.")
                ? { hook: "900-changed" }
                : pointId === "mcp.tools"
                  ? { description: "Changed" }
                  : pointId === "execution.environment"
                    ? { automatic: true }
                    : pointId === "execution.sandbox"
                      ? {}
                      : { title: "Changed" };
            const makeDeclaration = (
                generation: string,
            ): ExtensionPointDeclaration =>
                mode === "changed" && generation === "g2"
                    ? { ...originalDeclaration, ...changed }
                    : {
                          ...Object.fromEntries(
                              Object.entries(originalDeclaration).reverse(),
                          ),
                          id: originalDeclaration.id,
                      };
            const makeManifest = (
                id: string,
                generation = "g1",
            ): ExtensionManifest => ({
                ...manifest(id),
                extensions:
                    id === "blocker"
                        ? {}
                        : { [pointId]: [makeDeclaration(generation)] },
            });
            const host = new ExtensionHost({
                registry: {
                    read: async () => ({
                        schemaVersion: 1,
                        extensions: {
                            first: { enabled: true, selectedGeneration: "g1" },
                            blocker: {
                                enabled: true,
                                selectedGeneration: "g1",
                            },
                        },
                    }),
                    write: async () => {},
                },
                loader: {
                    points: createControlExtensionPointRegistry(),
                    readManifest: async (id, generation) =>
                        makeManifest(id, generation),
                    load: async (id, generation) => {
                        if (id === "blocker") {
                            loading.resolve();
                            await resume.promise;
                        }
                        return new ExtensionGeneration({
                            generation,
                            manifest: makeManifest(id, generation),
                            dispose: async () => {},
                            registrations: new ExtensionRegistrationSet(
                                id === "blocker"
                                    ? []
                                    : [
                                          {
                                              pointId,
                                              id: declarations[
                                                  pointId as keyof typeof declarations
                                              ].id,
                                              declaration:
                                                  makeDeclaration(generation),
                                              binding: pointId.startsWith(
                                                  "execution.",
                                              )
                                                  ? {
                                                        name: "shared",
                                                        version: 1,
                                                        executable: id,
                                                        args: [],
                                                    }
                                                  : async (input: {
                                                        value?: unknown;
                                                    }) => {
                                                        calls.push(id);
                                                        switch (pointId) {
                                                            case "tui.pages":
                                                                return {
                                                                    items: [],
                                                                };
                                                            case "web.pages":
                                                                return {
                                                                    tables: [],
                                                                };
                                                            case "mcp.tools":
                                                                return {
                                                                    structuredContent:
                                                                        {},
                                                                };
                                                            case "toolcall.rewrite":
                                                                return input.value;
                                                            default:
                                                                return {
                                                                    kind: "text",
                                                                    text: id,
                                                                };
                                                        }
                                                    },
                                          },
                                      ],
                            ),
                        });
                    },
                },
            });
            await host.start();
            t.after(async () => {
                resume.resolve();
                await host.stop();
            });
            const blocked = host.activateGeneration("blocker", "g1");
            await loading.promise;
            const disabled =
                mode === "foreign" ? host.disable("first") : Promise.resolve();
            const replaced = host.activateGeneration(
                mode === "foreign" ? "second" : "first",
                "g2",
            );
            const context = {
                requestId: "test",
                signal: new AbortController().signal,
                localOwner: true,
            };
            const invoke = async () => {
                switch (pointId) {
                    case "cli.native-commands":
                        return new CliExtensionCommandService(host, {
                            surface: "native",
                        }).command("shared", [], context as never);
                    case "cli.model-commands":
                        return new CliExtensionCommandService(host, {
                            surface: "model",
                        }).command("shared", [], context as never);
                    case "mcp.tools":
                        return new McpExtensionService(host).callTool(
                            "shared_tool",
                            {},
                            context as never,
                        );
                    case "tui.pages":
                        return new TuiExtensionPageService(host).invoke(
                            "shared",
                            {} as never,
                            context,
                        );
                    case "web.pages":
                        return new WebExtensionPageService(host).invoke(
                            "shared",
                            {} as never,
                            context,
                        );
                    case "execution.environment":
                        return resolveExecutionDrivers(host, {
                            environment: [
                                { name: "shared", order: 1, content: {} },
                            ],
                        });
                    case "execution.sandbox":
                        return resolveExecutionDrivers(host, {
                            sandbox: { name: "shared", content: {} },
                        });
                    default: {
                        let contribute!: (
                            ...args: unknown[]
                        ) => Promise<{
                            reviews: {
                                review(input: unknown): Promise<unknown>;
                            }[];
                            rewrites: {
                                rewrite(input: unknown): Promise<unknown>;
                            }[];
                            release(): void;
                        }>;
                        new ToolCallExtensionBinding(host).install({
                            registerContributor(fn: typeof contribute) {
                                contribute = fn;
                                return () => {};
                            },
                        } as never);
                        const contribution = await contribute(
                            {},
                            { signal: context.signal },
                        );
                        const hookInput = {
                            callId: "call",
                            direction: "inbound",
                            value: {
                                context: {},
                                kind: "call",
                                payload: {},
                                toolName: "tool",
                            },
                        };
                        await contribution.reviews[0]?.review(hookInput);
                        await contribution.rewrites[0]?.rewrite(hookInput);
                        contribution.release();
                    }
                }
            };
            const allowed =
                mode === "same" ||
                (mode === "changed" && pointId === "execution.sandbox");
            const pending = invoke();
            const checked = allowed ? pending : assert.rejects(pending);
            resume.resolve();
            await Promise.all([blocked, disabled, replaced, checked]);
            assert.deepEqual(
                calls,
                allowed && !pointId.startsWith("execution.") ? ["first"] : [],
            );
            const lease = await host.acquireRegistration(
                pointId,
                originalDeclaration.id,
            );
            assert.equal(
                lease.extensionId,
                mode === "foreign" ? "second" : "first",
            );
            lease.lease.release();
        });
    }

for (const branch of [
    "activate",
    "registry",
    "rollback",
    "identity",
    "lazy-abandon",
    "lazy-commit",
    "select-fault",
    "recovery",
] as const) {
    test(`unpublished ${branch} candidate retains original failure and drain ownership`, async () => {
        let healthy = false;
        let attempts = 0;
        let loads = 0;
        let rejectedCandidate!: ExtensionGeneration;
        let oldRuntime!: ExtensionGeneration;
        const original = new Error(`${branch} original failure`);
        const cleanup = new Error("candidate cleanup failure");
        const snapshot = {
            schemaVersion: 1 as const,
            extensions: { first: { enabled: true, selectedGeneration: "g1" } },
        };
        const host = new ExtensionHost({
            registry: {
                read: async () => snapshot,
                write: async () => {
                    if (branch === "registry") throw original;
                    if (branch === "rollback")
                        rejectedCandidate.fault(original);
                },
            },
            loader: {
                points: createControlExtensionPointRegistry(),
                readManifest: async () => manifest("first"),
                load: async (_id, generation) => {
                    loads++;
                    const isOld = branch === "recovery" && loads === 1;
                    const candidate = new ExtensionGeneration({
                        generation,
                        manifest: manifest(
                            branch === "identity" ? "foreign" : "first",
                        ),
                        registrations: new ExtensionRegistrationSet([
                            {
                                pointId: "cli.native-commands",
                                id: "shared",
                                declaration: { id: "shared", title: "Shared" },
                                binding: async () => {},
                            },
                        ]),
                        dispose: async () => {
                            if (isOld) return;
                            attempts++;
                            if (!healthy) throw cleanup;
                        },
                    });
                    if (!isOld) rejectedCandidate = candidate;
                    else oldRuntime = candidate;
                    if (
                        branch === "activate" ||
                        branch === "lazy-commit" ||
                        branch === "select-fault" ||
                        (branch === "recovery" && !isOld)
                    )
                        candidate.fault(original);
                    if (branch === "lazy-abandon")
                        delete (snapshot.extensions as Record<string, unknown>)
                            .first;
                    return candidate;
                },
            },
        });
        await host.start();
        if (branch === "recovery") {
            const acquired = await host.acquireRegistration(
                "cli.native-commands",
                "shared",
            );
            acquired.lease.release();
            oldRuntime.fault(original);
            await new Promise<void>((resolve) => setImmediate(resolve));
            const records = await host.list();
            assert.equal(records[0]!.state, "failed");
            assert.equal(records[0]!.failure!.message, original.message);
        } else if (branch === "lazy-abandon") {
            await assert.rejects(
                host.acquireRegistration("cli.native-commands", "shared"),
                /cleanup was incomplete/,
            );
        } else {
            const pending =
                branch === "lazy-commit"
                    ? host.acquireRegistration("cli.native-commands", "shared")
                    : branch === "select-fault"
                      ? host.selectGeneration("first", "g2")
                      : host.activateGeneration("first", "g2");
            await assert.rejects(pending, (error: unknown) => {
                assert.ok(error instanceof Error);
                const cause = error.cause ?? error;
                assert.ok(cause instanceof AggregateError);
                assert.equal(cause.errors[1], cleanup);
                if (branch === "identity") {
                    assert.ok(cause.errors[0] instanceof Error);
                    assert.equal(
                        cause.errors[0].message,
                        "Extension generation g2 declares id foreign, expected first.",
                    );
                } else {
                    assert.equal(cause.errors[0], original);
                }
                return true;
            });
        }
        assert.equal(attempts, 1);
        assert.equal(rejectedCandidate.state, "dispose-failed");
        await assert.rejects(host.waitForDrain("first"), /failed to drain/);
        assert.equal(attempts, 2);
        healthy = true;
        await host.waitForDrain("first");
        assert.equal(attempts, 3);
        assert.equal(rejectedCandidate.state, "disposed");
        await host.stop();
        assert.equal(attempts, 3);
    });
}

import { EventEmitter } from "node:events";
import { ExtensionWebGateway } from "../../../src/server/web/extension/application/Gateway.ts";

for (const surface of ["http", "upgrade"] as const) {
    test(`Web application ${surface} admission rejects queued foreign binding`, async (t) => {
        const loading = deferred();
        const resume = deferred();
        const makeManifest = (id: string): ExtensionManifest => ({
            ...manifest(id),
            extensions:
                id === "blocker"
                    ? {}
                    : {
                          "web.applications": [
                              { id: "shared", title: "Shared" },
                          ],
                      },
        });
        let resolutions = 0;
        const host = new ExtensionHost({
            registry: {
                read: async () => ({
                    schemaVersion: 1,
                    extensions: {
                        first: { enabled: true, selectedGeneration: "g1" },
                    },
                }),
                write: async () => {},
            },
            loader: {
                points: createControlExtensionPointRegistry(),
                readManifest: async (id) => makeManifest(id),
                load: async (id, generation) => {
                    if (id === "blocker") {
                        loading.resolve();
                        await resume.promise;
                    }
                    return new ExtensionGeneration({
                        generation,
                        manifest: makeManifest(id),
                        dispose: async () => {},
                        registrations: new ExtensionRegistrationSet(
                            id === "blocker"
                                ? []
                                : [
                                      {
                                          pointId: "web.applications",
                                          id: "shared",
                                          declaration: {
                                              id: "shared",
                                              title: "Shared",
                                          },
                                          binding: {
                                              source: {
                                                  kind: "proxy",
                                                  resolve() {
                                                      resolutions++;
                                                      throw new Error(
                                                          "must not resolve foreign upstream",
                                                      );
                                                  },
                                              },
                                          },
                                      },
                                  ],
                        ),
                    });
                },
            },
        });
        await host.start();
        t.after(async () => {
            resume.resolve();
            await host.stop();
        });
        let http!: (...args: unknown[]) => Promise<void>;
        let upgrade!: (...args: unknown[]) => Promise<void>;
        new ExtensionWebGateway({
            basePath: "/extensions",
            loginPath: "/login",
            extensions: {
                acquireRegistration: host.acquireRegistration.bind(host),
                listDeclarations: host.listDeclarations.bind(host),
                generationDirectory: () => "/unused",
            },
        }).install(
            {
                registerRawPrefix(_prefix: string, handler: typeof http) {
                    http = handler;
                    return () => {};
                },
                registerUpgradePrefix(
                    _prefix: string,
                    handler: typeof upgrade,
                ) {
                    upgrade = handler;
                    return () => {};
                },
            } as never,
            {
                authorize: () => true,
                authorizeToken: () => "token",
                onRevoked: () => () => {},
            } as never,
        );
        const blocked = host.activateGeneration("blocker", "g1");
        await loading.promise;
        const disabled = host.disable("first");
        const replacement = host.activateGeneration("second", "g2");
        let status = 0;
        let output = "";
        const response = {
            writableEnded: false,
            set statusCode(value: number) {
                status = value;
            },
            setHeader() {},
            end(value: string) {
                output = value;
            },
        };
        const socket = Object.assign(new EventEmitter(), {
            destroyed: false,
            write(value: string) {
                output += value;
            },
            destroy(this: EventEmitter & { destroyed: boolean }) {
                this.destroyed = true;
                this.emit("close");
            },
            end(value: string) {
                output += value;
            },
        });
        const pending =
            surface === "http"
                ? http({ url: "/shared/api", headers: {} }, response)
                : upgrade(
                      { url: "/extensions/shared/api", headers: {} },
                      socket,
                      Buffer.alloc(0),
                  );
        resume.resolve();
        await Promise.all([blocked, disabled, replacement, pending]);
        assert.equal(resolutions, 0);
        assert.equal(
            surface === "http" ? status : Number(output.split(" ")[1]),
            503,
        );
        const observation = host.acquire("second");
        assert.equal(
            observation.registrations.get("web.applications", "shared")!.id,
            "shared",
        );
        observation.release();
    });
}

for (const changedHook of [false, true]) {
    test(`retired outbound hook checks retained semantic identity changed=${changedHook}`, async (t) => {
        const calls: string[] = [];
        const makeManifest = (generation: string): ExtensionManifest => ({
            ...manifest("first"),
            extensions: {
                "toolcall.rewrite": [
                    {
                        id: "shared",
                        hook:
                            generation === "g2" && changedHook
                                ? "900-changed"
                                : "100-shared",
                    },
                ],
            },
        });
        const runtimes: ExtensionGeneration[] = [];
        const host = new ExtensionHost({
            registry: {
                read: async () => ({
                    schemaVersion: 1,
                    extensions: {
                        first: { enabled: true, selectedGeneration: "g1" },
                    },
                }),
                write: async () => {},
            },
            loader: {
                points: createControlExtensionPointRegistry(),
                readManifest: async (_id, generation) =>
                    makeManifest(generation),
                load: async (_id, generation) => {
                    const runtime = new ExtensionGeneration({
                        generation,
                        manifest: makeManifest(generation),
                        dispose: async () => {},
                        registrations: new ExtensionRegistrationSet([
                            {
                                pointId: "toolcall.rewrite",
                                id: "shared",
                                declaration:
                                    makeManifest(generation).extensions[
                                        "toolcall.rewrite"
                                    ]![0]!,
                                binding: async (input: { value: unknown }) => {
                                    calls.push(generation);
                                    return input.value;
                                },
                            },
                        ]),
                    });
                    runtimes.push(runtime);
                    return runtime;
                },
            },
        });
        await host.start();
        t.after(async () => await host.stop());
        let contribute!: (
            ...args: unknown[]
        ) => Promise<{
            rewrites: { rewrite(input: unknown): Promise<unknown> }[];
            release(): void;
        }>;
        new ToolCallExtensionBinding(host).install({
            registerContributor(fn: typeof contribute) {
                contribute = fn;
                return () => {};
            },
        } as never);
        const contribution = await contribute(
            {},
            { signal: new AbortController().signal },
        );
        await host.activateGeneration("first", "g2");
        assert.equal(runtimes[0]!.state, "draining");
        const pending = contribution.rewrites[0].rewrite({
            callId: "call",
            direction: "outbound",
            value: {
                context: {},
                kind: "result",
                payload: {},
                toolName: "tool",
            },
        });
        const checked = changedHook
            ? assert.rejects(pending, /declaration changed/)
            : pending;
        await checked;
        assert.deepEqual(calls, changedHook ? [] : ["g2"]);
        contribution.release();
        await host.waitForDrain("first");
        assert.equal(runtimes[0]!.state, "disposed");
        assert.equal(runtimes[1]!.inFlight, 0);
    });
}

for (const automatic of [false, true]) {
    test(`automatic execution snapshot preserves declaration across activation automatic=${automatic}`, async (t) => {
        const loading = deferred();
        const resume = deferred();
        const runtimes: ExtensionGeneration[] = [];
        const makeManifest = (generation: string): ExtensionManifest => ({
            ...manifest("first"),
            extensions: {
                "execution.environment": [
                    {
                        id: "shared",
                        automatic: generation === "g1" ? true : automatic,
                    },
                ],
            },
        });
        const host = new ExtensionHost({
            registry: {
                read: async () => ({
                    schemaVersion: 1,
                    extensions: {
                        first: { enabled: true, selectedGeneration: "g1" },
                    },
                }),
                write: async () => {},
            },
            loader: {
                points: createControlExtensionPointRegistry(),
                readManifest: async (_id, generation) =>
                    makeManifest(generation),
                load: async (_id, generation) => {
                    loading.resolve();
                    await resume.promise;
                    const runtime = new ExtensionGeneration({
                        generation,
                        manifest: makeManifest(generation),
                        dispose: async () => {},
                        registrations: new ExtensionRegistrationSet([
                            {
                                pointId: "execution.environment",
                                id: "shared",
                                declaration: { id: "shared", automatic },
                                binding: {
                                    version: 1,
                                    name: "shared",
                                    executable: generation,
                                    args: [],
                                },
                            },
                        ]),
                    });
                    runtimes.push(runtime);
                    return runtime;
                },
            },
        });
        await host.start();
        t.after(async () => {
            resume.resolve();
            await host.stop();
        });
        const replacement = host.activateGeneration("first", "g2");
        await loading.promise;
        const pending = resolveExecutionDrivers(host);
        resume.resolve();
        await replacement;
        const resolved = await pending;
        assert.deepEqual(
            resolved,
            automatic
                ? {
                      environment: [
                          {
                              order: 1,
                              name: "shared",
                              content: {},
                              phase: "process",
                              driver: {
                                  version: 1,
                                  name: "shared",
                                  executable: "g2",
                                  args: [],
                              },
                          },
                      ],
                  }
                : {},
        );
        assert.equal(runtimes[0]!.inFlight, 0);
    });
}
