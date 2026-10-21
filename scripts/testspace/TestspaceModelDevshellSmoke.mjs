import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

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
    }, { versionNegotiation: { mode: "auto" } });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL(endpoint)),
        );
        const listed = await client.listTools();
        const names = new Set(listed.tools.map((tool) => tool.name));
        requireTool(names, "environ_info");
        requireTool(names, "environ_remote");
        requireTool(names, "bash_run");
        rejectTool(names, "artifact_transfer");
        rejectTool(names, "instance_list");
        assertRemoteSchema(
            listed.tools.find((tool) => tool.name === "environ_remote")
                ?.inputSchema,
        );
        if (listed.tools.find((tool) => tool.name === "bash_run")
            ?.inputSchema?.properties?.instance?.type !== "string") {
            throw new Error("bash_run must expose the explicit instance routing parameter");
        }

        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        if (typeof ctxId !== "string" || ctxId.length === 0) {
            throw new Error(
                "model devshell smoke environ_info did not return a ctxId",
            );
        }
        if (!Array.isArray(environment.structuredContent?.comment))
            throw new Error("environ_info must provide the minimal comment contract");

        const instanceStatus = await runBash(
            client,
            ctxId,
            `devshell instance status ${shellWord(instance)}`,
        );
        assertExit(instanceStatus, 0, "model devshell instance status");
        if (
            !String(instanceStatus.stdout ?? "").includes(
                `instance: ${instance}`,
            )
        ) {
            throw new Error(
                `model devshell instance status returned unexpected output: ${JSON.stringify(instanceStatus)}`,
            );
        }

        const instanceList = await runBash(
            client,
            ctxId,
            "devshell instance list",
        );
        assertExit(instanceList, 0, "model devshell instance list");
        const handle = parseRemoteHandle(instanceList.stdout, remoteInstance);

        const modelCatalog = await runBash(client, ctxId, "devshell --help");
        assertExit(modelCatalog, 0, "model devshell command catalog");
        for (const command of [
            "artifact", "instance", "memory", "mcp", "recall", "secret", "skill",
        ]) {
            if (!String(modelCatalog.stdout ?? "").split("\n").some((line) =>
                line.trim().split(/\s+/u)[0] === command)) {
                throw new Error(`model devshell catalog is missing ${command}: ${JSON.stringify(modelCatalog)}`);
            }
        }

        // Exercise the real Model CLI command handlers through MCP bash_run
        // and the running Worker, not their native CLI equivalents or --help.
        const memories = await runModelJson(client, ctxId, "devshell memory list");
        if (!Array.isArray(memories.memories)) {
            throw new Error(`model memory list did not query the workspace: ${JSON.stringify(memories)}`);
        }
        const profiles = await runModelJson(client, ctxId, "devshell mcp list");
        if (!Array.isArray(profiles)) {
            throw new Error(`model mcp list did not return the Extension profile catalog: ${JSON.stringify(profiles)}`);
        }
        const skills = await runModelJson(client, ctxId, "devshell skill list");
        if (!Array.isArray(skills.skills) || !Array.isArray(skills.warnings)) {
            throw new Error(`model skill list did not query the Worker workspace: ${JSON.stringify(skills)}`);
        }
        const secrets = await runModelJson(
            client,
            ctxId,
            "devshell secret scan . --glob '*.devshell-secret-smoke-absent' --limit 1",
        );
        if (!Array.isArray(secrets.findings) ||
            typeof secrets.truncated !== "boolean" ||
            typeof secrets.truncatedFiles !== "number") {
            throw new Error(`model secret scan did not execute against the Worker: ${JSON.stringify(secrets)}`);
        }

        const recallHelp = await runBash(client, ctxId, "devshell recall --help");
        assertExit(recallHelp, 0, "model devshell recall help");
        if (!String(recallHelp.stdout ?? "").includes("devshell recall")) {
            throw new Error(`model devshell recall help is invalid: ${JSON.stringify(recallHelp)}`);
        }
        for (const command of ["contexts", "calls --limit 3"]) {
            const recalled = await runBash(client, ctxId, `devshell recall ${command}`);
            assertExit(recalled, 0, `model devshell recall ${command}`);
            if (!String(recalled.stdout ?? "").includes(`Workspace: ${workspace}`)) {
                throw new Error(`model devshell recall ${command} used an unexpected Workspace: ${JSON.stringify(recalled)}`);
            }
        }

        const help = await client.callTool({
            arguments: { command: "help", ctxId },
            name: "environ_remote",
        });
        assertToolSuccess(help, "environ_remote help");
        const catalog = help.structuredContent?.details?.commands;
        if (
            !Array.isArray(catalog) ||
            !catalog.some((entry) => entry?.command === "attach") ||
            !catalog.some((entry) => entry?.command === "mask") ||
            catalog.some((entry) => entry?.command === "unmask")
        ) {
            throw new Error(
                `environ_remote help returned an invalid catalog: ${JSON.stringify(help.structuredContent)}`,
            );
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
        if (
            attached.structuredContent?.details?.instance !== remoteInstance ||
            attached.structuredContent?.details?.workspace !== remoteWorkspace
        ) {
            throw new Error(
                `environ_remote attach returned unexpected details: ${JSON.stringify(attached.structuredContent)}`,
            );
        }

        // Regression: execute the attached Reverse Worker through the ORIGINAL
        // MCP client/endpoint, not a dedicated Reverse endpoint.
        const remotePwd = await runBash(client, ctxId, "pwd", remoteInstance);
        assertExit(remotePwd, 0, "remote bash after environ_remote attach");
        if (String(remotePwd.stdout ?? "").trim() !== remoteWorkspace) {
            throw new Error(
                `remote bash ran in an unexpected workspace: ${JSON.stringify(remotePwd)}`,
            );
        }

        const masked = await client.callTool({
            arguments: { command: "mask", ctxId, handle },
            name: "environ_remote",
        });
        assertToolSuccess(masked, "environ_remote mask");
        if (
            masked.structuredContent?.details?.instance !== remoteInstance ||
            masked.structuredContent?.details?.masked !== true
        ) {
            throw new Error(
                `environ_remote mask returned unexpected details: ${JSON.stringify(masked.structuredContent)}`,
            );
        }

        const listAfterMask = await runBash(
            client,
            ctxId,
            "devshell instance list",
        );
        assertExit(listAfterMask, 0, "model devshell instance list after mask");
        if (
            String(listAfterMask.stdout ?? "")
                .split(/\r?\n/u)
                .some((line) => line.startsWith(`${remoteInstance}\t`))
        ) {
            throw new Error(
                `masked instance remains model-visible: ${JSON.stringify(listAfterMask)}`,
            );
        }

        await assertToolErrorCall(
            async () =>
                await client.callTool({
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
            async () =>
                await client.callTool({
                    arguments: { command: "unmask", ctxId, handle },
                    name: "environ_remote",
                }),
            "environ_remote unmask",
            "command='help'",
        );

        const artifactShares = await runBash(
            client,
            ctxId,
            "devshell artifact shares",
        );
        assertExit(artifactShares, 0, "model devshell artifact shares");

        const denied = await runBash(client, ctxId, "devshell stop");
        assertExit(denied, 127, "model devshell denied builtin stop");
        if (
            !String(denied.stderr ?? "").includes(
                "CLI command stop is unavailable.",
            )
        ) {
            throw new Error(
                `model devshell did not reject builtin stop: ${JSON.stringify(denied)}`,
            );
        }

        return {
            artifactSharesExitCode: artifactShares.exitCode,
            ctxId,
            deniedBuiltinExitCode: denied.exitCode,
            environRemoteMask: true,
            instance,
            instanceStatusExitCode: instanceStatus.exitCode,
            modelCommandReadOnly: ["memory", "mcp", "secret", "skill"],
            recallExitCode: recallHelp.exitCode,
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

async function runModelJson(client, ctxId, command) {
    const response = await runBash(client, ctxId, command);
    assertExit(response, 0, `model ${command}`);
    try {
        return JSON.parse(String(response.stdout ?? ""));
    } catch (error) {
        throw new Error(`model ${command} did not return JSON: ${JSON.stringify(response)}`, {
            cause: error,
        });
    }
}

function assertRemoteSchema(schema) {
    if (
        schema?.type !== "object" ||
        schema.anyOf !== undefined ||
        schema.oneOf !== undefined
    ) {
        throw new Error(
            `environ_remote schema is not a stable object root: ${JSON.stringify(schema)}`,
        );
    }
    const command = schema.properties?.command;
    if (command?.type !== "string" || command.enum !== undefined) {
        throw new Error(
            `environ_remote command is not an open string: ${JSON.stringify(command)}`,
        );
    }
}

function parseRemoteHandle(stdout, instance) {
    const line = String(stdout ?? "")
        .split(/\r?\n/u)
        .find((value) => value.startsWith(`${instance}\t`));
    const match = line?.match(/(?:^|\s)handle=(ih-[^\s]+)/u);
    if (match?.[1] === undefined) {
        throw new Error(
            `model devshell instance list did not return a handle for ${instance}: ${JSON.stringify(stdout)}`,
        );
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
        const text =
            error instanceof Error
                ? `${error.message}\n${JSON.stringify(error)}`
                : JSON.stringify(error);
        assertErrorText(text, label, expected);
        return;
    }
    if (result.isError !== true) {
        throw new Error(
            `${label} unexpectedly succeeded: ${JSON.stringify(result)}`,
        );
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
        throw new Error(
            `${label} expected exit ${expected}, received ${JSON.stringify(result)}`,
        );
    }
}

function requireTool(names, name) {
    if (!names.has(name))
        throw new Error(`testspace MCP catalog is missing ${name}`);
}

function rejectTool(names, name) {
    if (names.has(name))
        throw new Error(
            `testspace MCP catalog still exposes retired tool ${name}`,
        );
}

function shellWord(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}
