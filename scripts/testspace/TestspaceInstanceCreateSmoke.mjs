import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { assertTestspaceExecutionContext } from "./TestspaceNamespace.mjs";
import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

/** Drive the actual model CLI through MCP and verify the persisted Control state. */
export async function runTestspaceInstanceCreateSmoke({ endpoint, runtimeDirectory, workspace }) {
    const root = process.env.DEVSHELL_TESTSPACE_ROOT;
    assertTestspaceExecutionContext(root, process.env);
    const client = new Client({
        name: "testspace-instance-create-smoke",
        version: "0.0.0",
    }, { versionNegotiation: { mode: "auto" } });
    const nonce = randomBytes(4).toString("hex");
    const names = [];
    const instances = async (operation) =>
        await withTestspaceControlConnection(runtimeDirectory, async (shared, endpointConnection) =>
            await operation(shared.createInstanceTransport(endpointConnection)));
    const configPath = (name) => join(root, "home", ".devshell", "control", "instances", name + ".toml");
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const availableTools = await client.listTools();
        assert.equal(availableTools.tools.some((tool) => tool.name === "instance_create"), false);
        const environment = await client.callTool({
            name: "environ_info",
            arguments: { workspace },
        });
        assert.notEqual(environment.isError, true);
        const ctxId = environment.structuredContent?.ctxId;
        assert.ok(typeof ctxId === "string" && ctxId.length > 0);
        const bash = async (command) => {
            const result = await client.callTool({
                name: "bash_run",
                arguments: { command, ctxId, timeoutMs: 30_000 },
            });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            return result.structuredContent ?? {};
        };

        const help = await bash("devshell instance help");
        assert.equal(help.exitCode, 0, JSON.stringify(help));
        assert.match(help.stdout, /devshell instance create/u);
        const noExtraCommand = await bash("devshell instance-create help");
        assert.equal(noExtraCommand.exitCode, 127, JSON.stringify(noExtraCommand));

        const baseline = (await instances((transport) => transport.listInstances()))
            .map((entry) => entry.name).sort();
        const schema = await instances((transport) => transport.createInstanceSchema());
        const drafts = [
            { name: `qa-create-${nonce}-local`, provider: "local" },
            { name: `qa-create-${nonce}-ssh`, provider: "ssh", ssh: { command: "ssh testspace.invalid" } },
            { name: `qa-create-${nonce}-reverse`, provider: "reverse" },
            { name: `qa-create-${nonce}-docker`, provider: "docker",
                container: { mode: "existingImage", image: "alpine:latest" } },
            { name: `qa-create-${nonce}-podman`, provider: "podman",
                container: { mode: "existingImage", image: "alpine:latest" } },
        ].filter((draft) => schema.providers.includes(draft.provider)).map((draft) => ({
            ...draft,
            enabled: false,
            mcp: { enabled: false },
        }));
        assert.ok(drafts.length >= 2, "Instance schema must provide multiple testable providers");
        const enabledLocal = {
            name: `qa-create-${nonce}-active-local`,
            provider: "local",
            enabled: true,
            mcp: { enabled: false },
        };
        drafts.push(enabledLocal);
        for (const draft of drafts) {
            names.push(draft.name);
            const result = await bash(`devshell instance create ${shellWord(JSON.stringify(draft))}`);
            assert.equal(result.exitCode, 0, `${draft.provider}: ${JSON.stringify(result)}`);
            const created = JSON.parse(result.stdout);
            assert.equal(created.name, draft.name);
            assert.equal(created.enabled, draft.enabled);
            const persisted = await readFile(configPath(draft.name), "utf8");
            assert.match(persisted, new RegExp(`name = "${draft.name}"`, "u"));
            assert.match(persisted, new RegExp(`provider = "${draft.provider}"`, "u"));
            const entry = (await instances((transport) => transport.listInstances()))
                .find((value) => value.name === draft.name);
            assert.equal(entry?.enabled, draft.enabled, `missing ${draft.provider} instance`);
            assert.equal(entry?.mcpEnabled, false);
            if (draft.enabled) {
                const runtime = await withTestspaceControlConnection(runtimeDirectory,
                    async (shared, endpointConnection) =>
                        await shared.createProcessTransport(endpointConnection, draft.name).snapshot());
                assert.equal(runtime.snapshot.name, draft.name);
                assert.equal(typeof runtime.snapshot.ready, "boolean");
            }
        }

        const duplicate = await bash(`devshell instance create ${shellWord(JSON.stringify(drafts[0]))}`);
        assert.notEqual(duplicate.exitCode, 0);
        assert.match(duplicate.stderr, /already exists/u);
        for (const invalid of ["not-json", "[]", "null", JSON.stringify({
            name: `qa-invalid-${nonce}`, provider: "unknown", enabled: false,
        })]) {
            const result = await bash(`devshell instance create ${shellWord(invalid)}`);
            assert.notEqual(result.exitCode, 0, `invalid input was accepted: ${invalid}`);
        }
        const after = await instances((transport) => transport.listInstances());
        assert.deepEqual(
            after.map((entry) => entry.name).sort(),
            [...baseline, ...names].sort(),
        );
        // Config removal alone is not a completed delete. A stale cleanup
        // debt can leave the name unusable despite a successful delete RPC.
        for (const draft of [...drafts].reverse()) {
            await instances(async (transport) => {
                const deleted = await transport.deleteInstance(draft.name);
                assert.equal(deleted.cleanupPending, false, `${draft.provider}: initial delete left lifecycle debt`);
                await transport.createInstance(draft);
                const repeated = await transport.deleteInstance(draft.name);
                assert.equal(repeated.cleanupPending, false, `${draft.provider}: repeated delete left lifecycle debt`);
            });
            await assert.rejects(readFile(configPath(draft.name), "utf8"), { code: "ENOENT" });
        }
        return { providers: drafts.map((draft) => draft.provider), created: names.length,
            enabledLocalRegistered: true, duplicateRejected: true,
            invalidRejected: 4, persistenceVerified: true,
            deleteRecreateVerified: true };
    } finally {
        try {
            await instances(async (transport) => {
                const existing = new Set((await transport.listInstances()).map((entry) => entry.name));
                for (const name of [...names].reverse()) {
                    if (existing.has(name)) await transport.deleteInstance(name);
                }
            });
            for (const name of names) {
                await assert.rejects(readFile(configPath(name), "utf8"), { code: "ENOENT" });
            }
        } finally {
            await client.close().catch(() => undefined);
        }
    }
}

function shellWord(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
