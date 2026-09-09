import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function runTestspaceModelDevshellSmoke({ endpoint, instance, workspace }) {
    const client = new Client({
        name: "portable-devshell-testspace-model-devshell-smoke",
        version: "0.0.0",
    });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        requireTool(names, "environ_info");
        requireTool(names, "bash_run");
        rejectTool(names, "artifact_transfer");
        rejectTool(names, "instance_list");

        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        if (typeof ctxId !== "string" || ctxId.length === 0) {
            throw new Error("model devshell smoke environ_info did not return a ctxId");
        }

        const instanceStatus = await runBash(client, ctxId, `devshell instance status ${shellWord(instance)}`);
        assertExit(instanceStatus, 0, "model devshell instance status");
        if (!String(instanceStatus.stdout ?? "").includes(`instance: ${instance}`)) {
            throw new Error(`model devshell instance status returned unexpected output: ${JSON.stringify(instanceStatus)}`);
        }

        const artifactShares = await runBash(client, ctxId, "devshell artifact shares");
        assertExit(artifactShares, 0, "model devshell artifact shares");

        const denied = await runBash(client, ctxId, "devshell stop");
        assertExit(denied, 127, "model devshell denied builtin stop");
        if (!String(denied.stderr ?? "").includes("CLI command stop is unavailable.")) {
            throw new Error(`model devshell did not reject builtin stop: ${JSON.stringify(denied)}`);
        }

        return {
            artifactSharesExitCode: artifactShares.exitCode,
            ctxId,
            deniedBuiltinExitCode: denied.exitCode,
            instance,
            instanceStatusExitCode: instanceStatus.exitCode,
            toolCount: names.size,
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}

async function runBash(client, ctxId, command) {
    const result = await client.callTool({
        arguments: {
            command,
            ctxId,
            timeoutMs: 30_000,
        },
        name: "bash_run",
    });
    return result.structuredContent ?? {};
}

function assertExit(result, expected, label) {
    if (result.exitCode !== expected) {
        throw new Error(`${label} expected exit ${expected}, received ${JSON.stringify(result)}`);
    }
}

function requireTool(names, name) {
    if (!names.has(name)) throw new Error(`testspace MCP catalog is missing ${name}`);
}

function rejectTool(names, name) {
    if (names.has(name)) throw new Error(`testspace MCP catalog still exposes retired tool ${name}`);
}

function shellWord(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}
