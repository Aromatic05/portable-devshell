import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function runTestspaceModelDevshellSmoke({
    endpoint,
    instance,
    remoteInstance,
    remoteWorkspace,
    workspace,
}) {
    const client = new Client({
        name: "portable-devshell-testspace-model-devshell-smoke",
        version: "0.0.0",
    });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        requireTool(names, "environ_info");
        requireTool(names, "environ_remote");
        requireTool(names, "bash_run");
        rejectTool(names, "artifact_transfer");
        rejectTool(names, "instance_list");
        assertRemoteSchema(listed.tools.find((tool) => tool.name === "environ_remote")?.inputSchema);

        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        if (typeof ctxId !== "string" || ctxId.length === 0) {
            throw new Error("model devshell smoke environ_info did not return a ctxId");
        }
        const remoteCommands = environment.structuredContent?.remoteEnvironment?.commands;
        if (!Array.isArray(remoteCommands) ||
            !remoteCommands.includes("help") ||
            !remoteCommands.some((value) => String(value).startsWith("attach ")) ||
            !remoteCommands.some((value) => String(value).startsWith("mask "))) {
            throw new Error(`environ_info did not advertise remote commands: ${JSON.stringify(environment.structuredContent)}`);
        }

        const instanceStatus = await runBash(client, ctxId, `devshell instance status ${shellWord(instance)}`);
        assertExit(instanceStatus, 0, "model devshell instance status");
        if (!String(instanceStatus.stdout ?? "").includes(`instance: ${instance}`)) {
            throw new Error(`model devshell instance status returned unexpected output: ${JSON.stringify(instanceStatus)}`);
        }

        const instanceList = await runBash(client, ctxId, "devshell instance list");
        assertExit(instanceList, 0, "model devshell instance list");
        const handle = parseRemoteHandle(instanceList.stdout, remoteInstance);

        const help = await client.callTool({
            arguments: { command: "help", ctxId },
            name: "environ_remote",
        });
        assertToolSuccess(help, "environ_remote help");
        const catalog = help.structuredContent?.details?.commands;
        if (!Array.isArray(catalog) ||
            !catalog.some((entry) => entry?.command === "attach") ||
            !catalog.some((entry) => entry?.command === "mask") ||
            catalog.some((entry) => entry?.command === "unmask")) {
            throw new Error(`environ_remote help returned an invalid catalog: ${JSON.stringify(help.structuredContent)}`);
        }

        const attached = await client.callTool({
            arguments: {
                command: "attach",
                ctxId,
                handle,
                workspace: remoteWorkspace,
            },
            name: "environ_remote",
        });
        assertToolSuccess(attached, "environ_remote attach");
        if (attached.structuredContent?.details?.instance !== remoteInstance ||
            attached.structuredContent?.details?.workspace !== remoteWorkspace) {
            throw new Error(`environ_remote attach returned unexpected details: ${JSON.stringify(attached.structuredContent)}`);
        }

        const remotePwd = await runBash(client, ctxId, "pwd", remoteInstance);
        assertExit(remotePwd, 0, "remote bash after environ_remote attach");
        if (String(remotePwd.stdout ?? "").trim() !== remoteWorkspace) {
            throw new Error(`remote bash ran in an unexpected workspace: ${JSON.stringify(remotePwd)}`);
        }

        const masked = await client.callTool({
            arguments: { command: "mask", ctxId, handle },
            name: "environ_remote",
        });
        assertToolSuccess(masked, "environ_remote mask");
        if (masked.structuredContent?.details?.instance !== remoteInstance ||
            masked.structuredContent?.details?.masked !== true) {
            throw new Error(`environ_remote mask returned unexpected details: ${JSON.stringify(masked.structuredContent)}`);
        }

        const listAfterMask = await runBash(client, ctxId, "devshell instance list");
        assertExit(listAfterMask, 0, "model devshell instance list after mask");
        if (String(listAfterMask.stdout ?? "").split(/\r?\n/u).some((line) => line.startsWith(`${remoteInstance}\t`))) {
            throw new Error(`masked instance remains model-visible: ${JSON.stringify(listAfterMask)}`);
        }

        await assertToolErrorCall(
            async () => await client.callTool({
                arguments: {
                    command: "pwd",
                    ctxId,
                    instance: remoteInstance,
                    timeoutMs: 30_000,
                },
                name: "bash_run",
            }),
            "masked remote bash",
            "mcp.contextInstanceMasked",
        );

        await assertToolErrorCall(
            async () => await client.callTool({
                arguments: { command: "unmask", ctxId, handle },
                name: "environ_remote",
            }),
            "environ_remote unmask",
            "command='help'",
        );

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
            environRemoteMask: true,
            instance,
            instanceStatusExitCode: instanceStatus.exitCode,
            remoteInstance,
            toolCount: names.size,
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}

async function runBash(client, ctxId, command, instance) {
    const result = await client.callTool({
        arguments: {
            command,
            ctxId,
            ...(instance === undefined ? {} : { instance }),
            timeoutMs: 30_000,
        },
        name: "bash_run",
    });
    return result.structuredContent ?? {};
}

function assertRemoteSchema(schema) {
    if (schema?.type !== "object" || schema.anyOf !== undefined || schema.oneOf !== undefined) {
        throw new Error(`environ_remote schema is not a stable object root: ${JSON.stringify(schema)}`);
    }
    const command = schema.properties?.command;
    if (command?.type !== "string" || command.enum !== undefined) {
        throw new Error(`environ_remote command is not an open string: ${JSON.stringify(command)}`);
    }
}

function parseRemoteHandle(stdout, instance) {
    const line = String(stdout ?? "")
        .split(/\r?\n/u)
        .find((value) => value.startsWith(`${instance}\t`));
    const match = line?.match(/(?:^|\s)handle=(ih-[^\s]+)/u);
    if (match?.[1] === undefined) {
        throw new Error(`model devshell instance list did not return a handle for ${instance}: ${JSON.stringify(stdout)}`);
    }
    return match[1];
}

function assertToolSuccess(result, label) {
    if (result.isError === true) {
        throw new Error(`${label} failed: ${JSON.stringify(result)}`);
    }
}

async function assertToolErrorCall(call, label, expected) {
    let result;
    try {
        result = await call();
    } catch (error) {
        const text = error instanceof Error
            ? `${error.message}\n${JSON.stringify(error)}`
            : JSON.stringify(error);
        assertErrorText(text, label, expected);
        return;
    }
    if (result.isError !== true) {
        throw new Error(`${label} unexpectedly succeeded: ${JSON.stringify(result)}`);
    }
    assertErrorText(JSON.stringify(result), label, expected);
}

function assertErrorText(text, label, expected) {
    if (!text.includes(expected)) {
        throw new Error(`${label} did not report ${expected}: ${text}`);
    }
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
