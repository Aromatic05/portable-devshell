import assert from "node:assert/strict";
import test from "node:test";

import type {
    PrefixRouteContext,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";
import {
    errorCodes,
    toControlErrorBody
} from "@portable-devshell/shared";

import { CliExtensionCommandService } from "../../../src/control/cli/CliExtensionCommandService.ts";
import { createCliRouteModule } from "../../../src/control/cli/CliRouteModule.ts";
import type { ExtensionCatalogRegistration } from "../../../src/control/extension/host/generation/ExtensionCatalog.ts";
import { WebApplicationCatalog } from "../../../src/server/web/extension/WebApplicationCatalog.ts";
import { createWebApplicationRouteModule } from "../../../src/server/web/extension/WebApplicationRouteModule.ts";

function registration(
    pointId: "cli.native-commands" | "web.applications",
    extensionId: string,
    id: string,
    declaration: Record<string, unknown>
): ExtensionCatalogRegistration {
    return {
        declaration: { id, ...declaration },
        extensionId,
        generation: "v1",
        id,
        pointId
    } as ExtensionCatalogRegistration;
}

function extensionHost(entries: readonly ExtensionCatalogRegistration[], events: string[] = []) {
    return {
        async acquireRegistration(pointId: string, id: string) {
            const entry = entries.find((candidate) => candidate.pointId === pointId && candidate.id === id);
            if (entry === undefined) throw new Error(`missing registration ${pointId}/${id}`);
            return {
                extensionId: entry.extensionId,
                lease: {
                    release() {
                        events.push(`release:${id}`);
                    }
                },
                registration: {
                    binding: async (argv: readonly string[], invocation: {
                        localOwner: boolean;
                        requestId: string;
                        workingDirectory?: string;
                    }) => {
                        events.push(
                            `command:${id}:${argv.join("|")}:${invocation.requestId}:`
                            + `${invocation.localOwner}:${invocation.workingDirectory ?? ""}`
                        );
                        if (argv[0] === "fail") throw new Error("binding failed");
                        return { kind: "text" as const, text: "ok" };
                    },
                    declaration: entry.declaration,
                    id: entry.id,
                    pointId: entry.pointId
                }
            } as never;
        },
        listDeclarations(pointId: string) {
            return entries.filter((entry) => entry.pointId === pointId);
        }
    };
}

function context(
    peer: "cli" | "tui" | "web",
    subjectKind = peer === "cli" ? "local-owner" : "web-session"
): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        subject: { id: "subject-1", kind: subjectKind }
    } as PrefixRouteContext;
}

function operation(module: PrefixRouteModuleDefinition, name: string) {
    const found = module.operations.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`${module.name}.${name} operation is missing`);
    return found;
}

test("CLI discovery projects only cli.native-commands declaration metadata", () => {
    const service = new CliExtensionCommandService(extensionHost([
        registration("cli.native-commands", "agent", "agent", {
            summary: "Run and manage Agent providers",
            title: "Agent",
            usage: "agent <command>"
        }),
        registration("web.applications", "agent", "agent", { title: "Agent Web" })
    ]), { surface: "native" });

    assert.deepEqual(service.list(), [{
        extensionId: "agent",
        id: "agent",
        summary: "Run and manage Agent providers",
        title: "Agent",
        usage: "agent <command>"
    }]);
    assert.equal("generation" in service.list()[0]!, false);
    assert.equal("binding" in service.list()[0]!, false);
});

test("model CLI discovery and dispatch include Control-resident Extension command providers", async () => {
    const calls: string[] = [];
    const service = new CliExtensionCommandService(extensionHost([]), {
        providers: [{
            binding: async (argv, invocation) => {
                calls.push(`${argv.join("|")}:${invocation.requestId}:${invocation.surface}`);
                return { kind: "text", text: "resident-ok" };
            },
            declaration: {
                id: "artifact",
                summary: "Manage artifacts",
                title: "Artifact",
                usage: "artifact <command>"
            },
            extensionId: "artifact",
            surface: "model"
        }],
        surface: "model"
    });

    assert.deepEqual(service.list(), [{
        extensionId: "artifact",
        id: "artifact",
        summary: "Manage artifacts",
        title: "Artifact",
        usage: "artifact <command>"
    }]);
    assert.deepEqual(await service.command("artifact", ["shares"], {
        requestId: "req-resident",
        signal: new AbortController().signal
    }), { kind: "text", text: "resident-ok" });
    assert.deepEqual(calls, ["shares:req-resident:model"]);
});

test("model CLI state never falls back to native Extension commands", async () => {
    const service = new CliExtensionCommandService(extensionHost([
        registration("cli.native-commands", "status-ui", "status", { title: "Native Status" })
    ]), { surface: "model" });

    assert.deepEqual(service.list(), []);
    await assert.rejects(
        async () => await service.command("status", [], {
            requestId: "req-model",
            signal: new AbortController().signal
        }),
        (error: unknown) => {
            const body = toControlErrorBody(error);
            assert.equal(body?.code, errorCodes.controlCliCommandFailed);
            assert.deepEqual(body?.details, { commandId: "status" });
            return true;
        }
    );
});

test("Web discovery projects only web.applications declaration metadata", () => {
    const catalog = new WebApplicationCatalog(extensionHost([
        registration("web.applications", "agent", "agent", { title: "Agent" }),
        registration("cli.native-commands", "agent", "agent", { title: "Agent CLI" })
    ]));

    assert.deepEqual(catalog.list(), [{
        extensionId: "agent",
        id: "agent",
        title: "Agent"
    }]);
    assert.equal("generation" in catalog.list()[0]!, false);
    assert.equal("binding" in catalog.list()[0]!, false);
});

test("CLI command route owns invocation, caller cwd, and payload validation", async () => {
    const events: string[] = [];
    const service = new CliExtensionCommandService(extensionHost([
        registration("cli.native-commands", "agent", "agent", { title: "Agent" })
    ], events), { surface: "native" });
    const cli = createCliRouteModule(service);
    const command = operation(cli, "command");

    assert.deepEqual(await command.handle({
        id: "1",
        name: "command",
        payload: { argv: ["--help"], commandId: "agent" }
    }, context("cli", "bearer")), { kind: "text", text: "ok" });
    assert.deepEqual(await command.handle({
        id: "2",
        name: "command",
        payload: { argv: ["provider", "list"], commandId: "agent", workingDirectory: "/repo" }
    }, context("cli", "local-owner")), { kind: "text", text: "ok" });
    await assert.rejects(
        async () => await command.handle({
            id: "2a",
            name: "command",
            payload: { argv: ["fail"], commandId: "agent" }
        }, context("cli", "local-owner")),
        /binding failed/u
    );

    await assert.rejects(
        async () => await command.handle({
            id: "3",
            name: "command",
            payload: { argv: [], commandId: "agent", workingDirectory: "/repo" }
        }, context("cli", "bearer")),
        /workingDirectory is restricted to the local owner CLI/iu
    );
    await assert.rejects(
        async () => await command.handle({
            id: "4",
            name: "command",
            payload: { argv: [], commandId: "agent" }
        }, context("web")),
        /only to CLI clients/iu
    );
    await assert.rejects(
        async () => await command.handle({
            id: "5",
            name: "command",
            payload: { argv: [], commandId: "Bad_ID" }
        }, context("cli")),
        /commandId must match/iu
    );
    await assert.rejects(
        async () => await command.handle({
            id: "6",
            name: "command",
            payload: { argv: [1], commandId: "agent" }
        }, context("cli")),
        /array of strings/iu
    );
    await assert.rejects(
        async () => await command.handle({
            id: "7",
            name: "command",
            payload: { argv: [], commandId: "agent", workingDirectory: "relative" }
        }, context("cli")),
        /workingDirectory must be an absolute path/iu
    );

    assert.deepEqual(events, [
        "command:agent:--help:req-1:false:",
        "release:agent",
        "command:agent:provider|list:req-1:true:/repo",
        "release:agent",
        "command:agent:fail:req-1:true:",
        "release:agent"
    ]);
});

test("CLI command acquisition failure is translated without leaking ExtensionHost errors", async () => {
    const service = new CliExtensionCommandService(extensionHost([]), { surface: "native" });
    const cli = createCliRouteModule(service);
    const command = operation(cli, "command");

    await assert.rejects(
        async () => await command.handle({
            id: "1",
            name: "command",
            payload: { argv: [], commandId: "missing" }
        }, context("cli", "local-owner")),
        (error: unknown) => {
            const body = toControlErrorBody(error);
            assert.equal(body?.code, errorCodes.controlCliCommandFailed);
            assert.equal(body?.message, "CLI command missing is unavailable.");
            assert.deepEqual(body?.details, { commandId: "missing" });
            assert.equal(body?.cause, undefined);
            assert.doesNotMatch(body?.message ?? "", /missing registration|Extension/u);
            return true;
        }
    );
});

test("CLI and Web discovery routes enforce their owning client domain", async () => {
    const cli = createCliRouteModule(new CliExtensionCommandService(extensionHost([
        registration("cli.native-commands", "agent", "agent", { title: "Agent" })
    ]), { surface: "native" }));
    const web = createWebApplicationRouteModule({
        list: () => [{ extensionId: "agent", id: "agent", title: "Agent" }]
    });

    assert.deepEqual(
        await operation(cli, "commands").handle({ id: "1", name: "commands" }, context("cli")),
        [{ extensionId: "agent", id: "agent", title: "Agent" }]
    );
    await assert.rejects(
        async () => await operation(cli, "commands").handle({ id: "2", name: "commands" }, context("web")),
        /only to CLI clients/u
    );

    assert.deepEqual(
        await operation(web, "applications").handle({ id: "3", name: "applications" }, context("web")),
        [{ extensionId: "agent", id: "agent", title: "Agent" }]
    );
    await assert.rejects(
        async () => await operation(web, "applications").handle({ id: "4", name: "applications" }, context("cli")),
        /only to Web clients/u
    );
});
