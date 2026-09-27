import assert from "node:assert/strict";
import test from "node:test";

import type {
    PrefixRouteContext,
    PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";
import { errorCodes, toControlErrorBody } from "@portable-devshell/shared";
import type {
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";

import { CliExtensionCommandService } from "../../../../src/control/extension/cli/command/Service.ts";
import { createCliRouteModule } from "../../../../src/control/extension/cli/Route.ts";
import {
    createTuiPageRouteModule,
    TuiExtensionPageService,
} from "../../../../src/control/extension/tui/Route.ts";
import type { ExtensionCatalogRegistration } from "../../../../src/control/extension/generation/discovery/Catalog.ts";
import { WebApplicationCatalog } from "../../../../src/server/web/extension/application/Catalog.ts";
import { createWebApplicationRouteModule } from "../../../../src/server/web/extension/application/Route.ts";
import { WebExtensionPageService } from "../../../../src/server/web/extension/page/Service.ts";

function registration(
    pointId:
        | "cli.model-commands"
        | "cli.native-commands"
        | "tui.pages"
        | "web.applications"
        | "web.pages",
    extensionId: string,
    id: string,
    declaration: Record<string, unknown>,
): ExtensionCatalogRegistration {
    return {
        declaration: { id, ...declaration },
        extensionId,
        generation: "v1",
        id,
        pointId,
    } as ExtensionCatalogRegistration;
}

function extensionHost(
    entries: readonly ExtensionCatalogRegistration[],
    events: string[] = [],
) {
    return {
        async acquireRegistration(pointId: string, id: string) {
            const entry = entries.find(
                (candidate) =>
                    candidate.pointId === pointId && candidate.id === id,
            );
            if (entry === undefined)
                throw new Error(`missing registration ${pointId}/${id}`);
            return {
                extensionId: entry.extensionId,
                lease: {
                    release() {
                        events.push(`release:${id}`);
                    },
                },
                registration: {
                    binding: async (
                        argv: readonly string[],
                        invocation:
                            | CliModelCommandInvocationContext
                            | CliNativeCommandInvocationContext,
                    ) => {
                        if (pointId === "cli.model-commands") {
                            const modelInvocation =
                                invocation as CliModelCommandInvocationContext;
                            events.push(
                                `model:${id}:${argv.join("|")}:${modelInvocation.requestId}:` +
                                    `${modelInvocation.instance}:${modelInvocation.workspace}`,
                            );
                        } else {
                            const nativeInvocation =
                                invocation as CliNativeCommandInvocationContext;
                            events.push(
                                `command:${id}:${argv.join("|")}:${nativeInvocation.requestId}:` +
                                    `${nativeInvocation.localOwner}:${nativeInvocation.workingDirectory ?? ""}`,
                            );
                        }
                        if (argv[0] === "fail")
                            throw new Error("binding failed");
                        return { kind: "text" as const, text: "ok" };
                    },
                    declaration: entry.declaration,
                    id: entry.id,
                    pointId: entry.pointId,
                },
            } as never;
        },
        listDeclarations(pointId: string) {
            return entries.filter((entry) => entry.pointId === pointId);
        },
    };
}

function context(
    peer: "cli" | "tui" | "web",
    subjectKind = peer === "cli" ? "local-owner" : "web-session",
): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        subject: { id: "subject-1", kind: subjectKind },
    } as PrefixRouteContext;
}

function operation(module: PrefixRouteModuleDefinition, name: string) {
    const found = module.operations.find(
        (candidate) => candidate.name === name,
    );
    if (found === undefined)
        throw new Error(`${module.name}.${name} operation is missing`);
    return found;
}

test("CLI discovery projects only cli.native-commands declaration metadata", () => {
    const service = new CliExtensionCommandService(
        extensionHost([
            registration("cli.native-commands", "agent", "agent", {
                summary: "Run and manage Agent providers",
                title: "Agent",
                usage: "agent <command>",
            }),
            registration("web.applications", "agent", "agent", {
                title: "Agent Web",
            }),
        ]),
        { surface: "native" },
    );

    assert.deepEqual(service.list(), [
        {
            extensionId: "agent",
            id: "agent",
            summary: "Run and manage Agent providers",
            title: "Agent",
            usage: "agent <command>",
        },
    ]);
    assert.equal("generation" in service.list()[0]!, false);
    assert.equal("binding" in service.list()[0]!, false);
});

test("model CLI discovery and dispatch come from cli.model-commands registrations", async () => {
    const calls: string[] = [];
    const service = new CliExtensionCommandService(
        extensionHost(
            [
                registration("cli.model-commands", "artifact", "artifact", {
                    summary: "Manage artifacts",
                    title: "Artifact",
                    usage: "artifact <command>",
                }),
            ],
            calls,
        ),
        { surface: "model" },
    );

    assert.deepEqual(service.list(), [
        {
            extensionId: "artifact",
            id: "artifact",
            summary: "Manage artifacts",
            title: "Artifact",
            usage: "artifact <command>",
        },
    ]);
    assert.deepEqual(
        await service.command("artifact", ["shares"], {
            context: {
                async instanceReference() {
                    return { current: true };
                },
            },
            instance: "demo-local",
            requestId: "req-model",
            signal: new AbortController().signal,
            workspace: "/repo",
        }),
        { kind: "text", text: "ok" },
    );
    assert.deepEqual(calls, [
        "model:artifact:shares:req-model:demo-local:/repo",
        "release:artifact",
    ]);
});

test("model CLI state never falls back to native Extension commands", async () => {
    const service = new CliExtensionCommandService(
        extensionHost([
            registration("cli.native-commands", "status-ui", "status", {
                title: "Native Status",
            }),
        ]),
        { surface: "model" },
    );

    assert.deepEqual(service.list(), []);
    await assert.rejects(
        async () =>
            await service.command("status", [], {
                context: {
                    async instanceReference() {
                        return { current: true };
                    },
                },
                instance: "demo-local",
                requestId: "req-model",
                signal: new AbortController().signal,
                workspace: "/repo",
            }),
        (error: unknown) => {
            const body = toControlErrorBody(error);
            assert.equal(body?.code, errorCodes.controlCliCommandFailed);
            assert.deepEqual(body?.details, { commandId: "status" });
            return true;
        },
    );
});

test("Web discovery projects only web.applications declaration metadata", () => {
    const catalog = new WebApplicationCatalog(
        extensionHost([
            registration("web.applications", "agent", "agent", {
                title: "Agent",
            }),
            registration("cli.native-commands", "agent", "agent", {
                title: "Agent CLI",
            }),
        ]),
    );

    assert.deepEqual(catalog.list(), [
        {
            extensionId: "agent",
            id: "agent",
            title: "Agent",
        },
    ]);
    assert.equal("generation" in catalog.list()[0]!, false);
    assert.equal("binding" in catalog.list()[0]!, false);
});

test("Web and TUI Extension pages keep separate discovery, invocation, and client-domain contracts", async () => {
    const events: string[] = [];
    const entries = [
        registration("web.pages", "access", "access", { title: "Access Web" }),
        registration("tui.pages", "access", "access", { title: "Access TUI" }),
    ];
    const extensions = {
        async acquireRegistration(pointId: string, id: string) {
            const entry = entries.find(
                (candidate) => candidate.pointId === pointId && candidate.id === id,
            );
            if (entry === undefined) throw new Error(`missing ${pointId}/${id}`);
            const binding =
                pointId === "web.pages"
                    ? async (request: { kind: string }, invocation: { requestId: string }) => {
                          events.push(
                              `web:${request.kind}:${invocation.requestId}`,
                          );
                          return {
                              tables: [
                                  {
                                      columns: [{ id: "state", label: "State" }],
                                      id: "endpoints",
                                      rows: [
                                          {
                                              cells: { state: { text: "running" } },
                                              id: "endpoint",
                                          },
                                      ],
                                  },
                              ],
                          };
                      }
                    : async (
                          request: { kind: string },
                          invocation: { localOwner: boolean; requestId: string },
                      ) => {
                          events.push(
                              `tui:${request.kind}:${invocation.requestId}:${invocation.localOwner}`,
                          );
                          return {
                              items: [
                                  {
                                      id: "endpoint",
                                      summary: [{ text: "running" }],
                                      title: "endpoint",
                                  },
                              ],
                          };
                      };
            return {
                extensionId: entry.extensionId,
                lease: {
                    generation: "v1",
                    release() {
                        events.push(`release:${pointId}`);
                    },
                },
                registration: { ...entry, binding },
            } as never;
        },
        listDeclarations(pointId: string) {
            return entries.filter((entry) => entry.pointId === pointId);
        },
    };
    const webPages = new WebExtensionPageService(extensions as never);
    const tuiPages = new TuiExtensionPageService(extensions as never);
    const web = createWebApplicationRouteModule(
        { list: () => [] },
        webPages,
    );
    const tui = createTuiPageRouteModule(tuiPages);

    assert.deepEqual(
        await operation(web, "pages").handle(
            { id: "1", name: "pages" },
            context("web"),
        ),
        [{ extensionId: "access", id: "access", title: "Access Web" }],
    );
    assert.deepEqual(
        await operation(tui, "pages").handle(
            { id: "2", name: "pages" },
            context("tui", "local-owner"),
        ),
        [{ extensionId: "access", id: "access", title: "Access TUI" }],
    );
    assert.deepEqual(
        await operation(web, "page").handle(
            { id: "3", name: "page", payload: { kind: "read", pageId: "access" } },
            context("web"),
        ),
        {
            tables: [
                {
                    columns: [{ id: "state", label: "State" }],
                    id: "endpoints",
                    rows: [
                        { cells: { state: { text: "running" } }, id: "endpoint" },
                    ],
                },
            ],
        },
    );
    assert.deepEqual(
        await operation(tui, "page").handle(
            { id: "4", name: "page", payload: { kind: "read", pageId: "access" } },
            context("tui", "local-owner"),
        ),
        {
            items: [
                {
                    id: "endpoint",
                    summary: [{ text: "running" }],
                    title: "endpoint",
                },
            ],
        },
    );
    await assert.rejects(
        async () =>
            await operation(web, "page").handle(
                { id: "5", name: "page", payload: { kind: "read", pageId: "access" } },
                context("tui", "local-owner"),
            ),
        /only to Web clients/u,
    );
    await assert.rejects(
        async () =>
            await operation(tui, "page").handle(
                { id: "6", name: "page", payload: { kind: "read", pageId: "access" } },
                context("web"),
            ),
        /only to TUI clients/u,
    );
    assert.deepEqual(events, [
        "web:read:req-1",
        "release:web.pages",
        "tui:read:req-1:true",
        "release:tui.pages",
    ]);
});

test("Web and TUI Extension page services reject renderer-unsafe snapshots", async () => {
    function host(pointId: "web.pages" | "tui.pages", binding: unknown) {
        return {
            async acquireRegistration(requestedPointId: string, id: string) {
                assert.equal(requestedPointId, pointId);
                assert.equal(id, "unsafe");
                return {
                    extensionId: "example",
                    lease: { generation: "v1", release() {} },
                    registration: {
                        binding,
                        declaration: { id: "unsafe", title: "Unsafe" },
                        extensionId: "example",
                        generation: "v1",
                        id: "unsafe",
                        pointId,
                    },
                } as never;
            },
            listDeclarations() {
                return [];
            },
        };
    }

    const web = new WebExtensionPageService(
        host("web.pages", async () => ({
            tables: [
                {
                    columns: [{ id: "link", label: "Link" }],
                    id: "table",
                    rows: [
                        {
                            cells: {
                                link: {
                                    href: "javascript:alert(1)",
                                    text: "unsafe",
                                },
                            },
                            id: "row",
                        },
                    ],
                },
            ],
        })) as never,
    );
    await assert.rejects(
        async () =>
            await web.invoke(
                "unsafe",
                { kind: "read" },
                {
                    requestId: "web-unsafe",
                    signal: new AbortController().signal,
                },
            ),
        TypeError,
    );

    const tui = new TuiExtensionPageService(
        host("tui.pages", async () => ({
            items: [
                {
                    id: "row",
                    summary: [{ text: "one", tone: "unknown" }],
                    title: "Row",
                },
            ],
        })) as never,
    );
    await assert.rejects(
        async () =>
            await tui.invoke(
                "unsafe",
                { kind: "read" },
                {
                    localOwner: true,
                    requestId: "tui-unsafe",
                    signal: new AbortController().signal,
                },
            ),
        TypeError,
    );
});

test("CLI command route owns invocation, caller cwd, and payload validation", async () => {
    const events: string[] = [];
    const service = new CliExtensionCommandService(
        extensionHost(
            [
                registration("cli.native-commands", "agent", "agent", {
                    title: "Agent",
                }),
            ],
            events,
        ),
        { surface: "native" },
    );
    const cli = createCliRouteModule(service);
    const command = operation(cli, "command");

    assert.deepEqual(
        await command.handle(
            {
                id: "1",
                name: "command",
                payload: { argv: ["--help"], commandId: "agent" },
            },
            context("cli", "bearer"),
        ),
        { kind: "text", text: "ok" },
    );
    assert.deepEqual(
        await command.handle(
            {
                id: "2",
                name: "command",
                payload: {
                    argv: ["provider", "list"],
                    commandId: "agent",
                    workingDirectory: "/repo",
                },
            },
            context("cli", "local-owner"),
        ),
        { kind: "text", text: "ok" },
    );
    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "2a",
                    name: "command",
                    payload: { argv: ["fail"], commandId: "agent" },
                },
                context("cli", "local-owner"),
            ),
        /binding failed/u,
    );

    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "3",
                    name: "command",
                    payload: {
                        argv: [],
                        commandId: "agent",
                        workingDirectory: "/repo",
                    },
                },
                context("cli", "bearer"),
            ),
        /workingDirectory is restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "4",
                    name: "command",
                    payload: { argv: [], commandId: "agent" },
                },
                context("web"),
            ),
        /only to CLI clients/iu,
    );
    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "5",
                    name: "command",
                    payload: { argv: [], commandId: "Bad_ID" },
                },
                context("cli"),
            ),
        /commandId must match/iu,
    );
    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "6",
                    name: "command",
                    payload: { argv: [1], commandId: "agent" },
                },
                context("cli"),
            ),
        /array of strings/iu,
    );
    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "7",
                    name: "command",
                    payload: {
                        argv: [],
                        commandId: "agent",
                        workingDirectory: "relative",
                    },
                },
                context("cli"),
            ),
        /workingDirectory must be an absolute path/iu,
    );

    assert.deepEqual(events, [
        "command:agent:--help:req-1:false:",
        "release:agent",
        "command:agent:provider|list:req-1:true:/repo",
        "release:agent",
        "command:agent:fail:req-1:true:",
        "release:agent",
    ]);
});

test("CLI command acquisition failure is translated without leaking ExtensionHost errors", async () => {
    const service = new CliExtensionCommandService(extensionHost([]), {
        surface: "native",
    });
    const cli = createCliRouteModule(service);
    const command = operation(cli, "command");

    await assert.rejects(
        async () =>
            await command.handle(
                {
                    id: "1",
                    name: "command",
                    payload: { argv: [], commandId: "missing" },
                },
                context("cli", "local-owner"),
            ),
        (error: unknown) => {
            const body = toControlErrorBody(error);
            assert.equal(body?.code, errorCodes.controlCliCommandFailed);
            assert.equal(body?.message, "CLI command missing is unavailable.");
            assert.deepEqual(body?.details, { commandId: "missing" });
            assert.equal(body?.cause, undefined);
            assert.doesNotMatch(
                body?.message ?? "",
                /missing registration|Extension/u,
            );
            return true;
        },
    );
});

test("CLI and Web discovery routes enforce their owning client domain", async () => {
    const cli = createCliRouteModule(
        new CliExtensionCommandService(
            extensionHost([
                registration("cli.native-commands", "agent", "agent", {
                    title: "Agent",
                }),
            ]),
            { surface: "native" },
        ),
    );
    const web = createWebApplicationRouteModule({
        list: () => [{ extensionId: "agent", id: "agent", title: "Agent" }],
    });

    assert.deepEqual(
        await operation(cli, "commands").handle(
            { id: "1", name: "commands" },
            context("cli"),
        ),
        [{ extensionId: "agent", id: "agent", title: "Agent" }],
    );
    await assert.rejects(
        async () =>
            await operation(cli, "commands").handle(
                { id: "2", name: "commands" },
                context("web"),
            ),
        /only to CLI clients/u,
    );

    assert.deepEqual(
        await operation(web, "applications").handle(
            { id: "3", name: "applications" },
            context("web"),
        ),
        [{ extensionId: "agent", id: "agent", title: "Agent" }],
    );
    await assert.rejects(
        async () =>
            await operation(web, "applications").handle(
                { id: "4", name: "applications" },
                context("cli"),
            ),
        /only to Web clients/u,
    );
});
