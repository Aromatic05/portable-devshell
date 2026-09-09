import assert from "node:assert/strict";
import test from "node:test";

import type { PrefixRouteContext } from "@portable-devshell/shared";

import { CliExtensionCommandCatalog } from "../../../src/control/cli/CliExtensionCommandCatalog.ts";
import { createCliRouteModule } from "../../../src/control/cli/CliRouteModule.ts";
import type { ExtensionCatalogRegistration } from "../../../src/control/extension/host/generation/ExtensionCatalog.ts";
import { WebApplicationCatalog } from "../../../src/server/web/extension/WebApplicationCatalog.ts";
import { createWebApplicationRouteModule } from "../../../src/server/web/extension/WebApplicationRouteModule.ts";

function registration(
    pointId: "cli.commands" | "web.applications",
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

function declarations(entries: readonly ExtensionCatalogRegistration[]) {
    return {
        listDeclarations(pointId: string) {
            return entries.filter((entry) => entry.pointId === pointId);
        }
    };
}

function context(peer: "cli" | "tui" | "web"): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        subject: {
            id: "subject-1",
            kind: peer === "cli" ? "local-owner" : "web-session"
        }
    } as PrefixRouteContext;
}

function operation(module: ReturnType<typeof createCliRouteModule>, name: string) {
    const found = module.operations.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`${module.prefix}.${name} operation is missing`);
    return found;
}

test("CLI discovery projects only cli.commands declaration metadata", () => {
    const catalog = new CliExtensionCommandCatalog(declarations([
        registration("cli.commands", "agent", "agent", {
            summary: "Run and manage Agent providers",
            title: "Agent",
            usage: "agent <command>"
        }),
        registration("web.applications", "agent", "agent", { title: "Agent Web" })
    ]));

    assert.deepEqual(catalog.list(), [{
        extensionId: "agent",
        id: "agent",
        summary: "Run and manage Agent providers",
        title: "Agent",
        usage: "agent <command>"
    }]);
    assert.equal("generation" in catalog.list()[0]!, false);
    assert.equal("binding" in catalog.list()[0]!, false);
});

test("Web discovery projects only web.applications declaration metadata", () => {
    const catalog = new WebApplicationCatalog(declarations([
        registration("web.applications", "agent", "agent", { title: "Agent" }),
        registration("cli.commands", "agent", "agent", { title: "Agent CLI" })
    ]));

    assert.deepEqual(catalog.list(), [{
        extensionId: "agent",
        id: "agent",
        title: "Agent"
    }]);
    assert.equal("generation" in catalog.list()[0]!, false);
    assert.equal("binding" in catalog.list()[0]!, false);
});

test("CLI and Web discovery routes enforce their owning client domain", async () => {
    const cli = createCliRouteModule({
        list: () => [{ extensionId: "agent", id: "agent", title: "Agent" }]
    });
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
        await operation(web as ReturnType<typeof createCliRouteModule>, "applications")
            .handle({ id: "3", name: "applications" }, context("web")),
        [{ extensionId: "agent", id: "agent", title: "Agent" }]
    );
    await assert.rejects(
        async () => await operation(web as ReturnType<typeof createCliRouteModule>, "applications")
            .handle({ id: "4", name: "applications" }, context("cli")),
        /only to Web clients/u
    );
});
