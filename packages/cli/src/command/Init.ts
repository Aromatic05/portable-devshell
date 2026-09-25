import { createInterface } from "node:readline/promises";

import {
    createError,
    errorCodes,
    generateOAuth2ApprovalToken,
    type ConfigMcpPatch,
    type ConfigView,
    type InstanceSnapshot,
} from "@portable-devshell/shared";

import type { CliDispatchContext } from "./Dispatch.js";
import type { CliParsedCommand } from "./Parse.js";

const defaultInitialInstanceName = "local-pc";

interface CliInitResult {
    approval: "token" | "tui";
    approvalToken?: string;
    controlRunning: boolean;
    endpoint?: string;
    instance: string;
    instanceCreated: boolean;
    instanceEnabled: boolean;
    instanceReady: boolean;
    mcpEnabled: boolean;
}

export async function executeInit(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (command.kind !== "init") return false;

    if (!context.controlNegotiated) {
        await (await context.lifecycle()).start();
        await context.clients.reconnect?.();
        await context.negotiate();
    }

    let approvalToken: string | undefined;
    let instanceCreated = false;
    let config = await readConfig(context);
    const freshLike =
        config.instances.length === 0 &&
        config.mcp.oauth2.approval === "token" &&
        config.mcp.oauth2.token === undefined;
    const patch: ConfigMcpPatch = {};
    if (freshLike && !config.mcp.enabled) patch.enabled = true;
    if (
        config.mcp.oauth2.approval === "token" &&
        config.mcp.oauth2.token === undefined
    ) {
        approvalToken = generateOAuth2ApprovalToken();
        patch.oauth2 = {
            approval: "token",
            token: approvalToken,
        };
    }
    if (Object.keys(patch).length > 0) {
        await context.clients.config.update({ mcp: patch });
        config = await readConfig(context);
    }

    const existingLocal = config.instances.find(
        (instance) => instance.provider === "local",
    );
    let localInstanceName: string;
    if (existingLocal !== undefined) {
        localInstanceName = existingLocal.name;
    } else {
        const collision = config.instances.find(
            (instance) => instance.name === defaultInitialInstanceName,
        );
        if (collision !== undefined) {
            throw createError({
                code: errorCodes.instanceAlreadyExists,
                details: {
                    instance: defaultInitialInstanceName,
                    provider: collision.provider,
                },
                message: `Instance ${defaultInitialInstanceName} already exists with provider ${collision.provider}; refusing to replace it with the default local instance.`,
                retryable: false,
            });
        }
        await context.clients.instance.create({
            mcp: { contextMode: "openai-session" },
            name: defaultInitialInstanceName,
            provider: "local",
        });
        instanceCreated = true;
        localInstanceName = defaultInitialInstanceName;
        config = await readConfig(context);
    }

    const localInstance = config.instances.find(
        (instance) => instance.name === localInstanceName,
    );
    if (localInstance === undefined)
        throw new Error(`Initialized local instance ${localInstanceName} is missing.`);

    let snapshot: InstanceSnapshot | undefined;
    if (localInstance.enabled) {
        snapshot = await context.clients.runtime.start(localInstance.name, {
            input: context.stdin,
            output: context.stderr,
        });
    }

    const endpoint =
        config.mcp.enabled && config.mcp.publicBaseUrl !== undefined
            ? joinEndpoint(config.mcp.publicBaseUrl, localInstance.mcp.path)
            : undefined;
    const result: CliInitResult = {
        approval: config.mcp.oauth2.approval,
        ...(approvalToken === undefined ? {} : { approvalToken }),
        controlRunning: true,
        ...(endpoint === undefined ? {} : { endpoint }),
        instance: localInstance.name,
        instanceCreated,
        instanceEnabled: localInstance.enabled,
        instanceReady: snapshot?.ready ?? false,
        mcpEnabled: config.mcp.enabled,
    };
    context.writeValue(result, renderInitResult(result));
    if (freshLike && isInteractive(context)) await offerRemoteAccess(context);
    return true;
}

async function readConfig(context: CliDispatchContext): Promise<ConfigView> {
    return (await context.clients.config.get()) as unknown as ConfigView;
}


function joinEndpoint(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

function renderInitResult(result: CliInitResult): string {
    const lines = [
        "DevShell is initialized.",
        "",
        `Instance: ${result.instance}${result.instanceReady ? " (ready)" : result.instanceEnabled ? " (started)" : " (disabled)"}`,
    ];
    if (result.endpoint !== undefined) {
        lines.push("", "MCP endpoint", `  ${result.endpoint}`);
    } else {
        lines.push("", "MCP", "  disabled (existing configuration preserved)");
    }
    lines.push("", "OAuth2 approval");
    if (result.approval === "tui") {
        lines.push("  TUI approval (existing configuration preserved)");
    } else if (result.approvalToken !== undefined) {
        lines.push(`  ${result.approvalToken}`);
    } else {
        lines.push("  token configured");
    }
    lines.push("", "Open DevShell", "  devshell tui", "");
    return lines.join("\n");
}

async function offerRemoteAccess(context: CliDispatchContext): Promise<void> {
    const readline = createInterface({ input: context.stdin });
    try {
        context.stdout.write(
            [
                "Remote access?",
                "1. Cloudflare Tunnel",
                "2. Not now",
                "selection [2]: ",
            ].join("\n"),
        );
        const next = await readline[Symbol.asyncIterator]().next();
        const answer = next.done ? "" : next.value.trim().toLowerCase();
        if (answer !== "1" && answer !== "cloudflare") return;
    } finally {
        readline.close();
    }

    const result = await context.clients.cli.command("access", ["cloudflare"], {
        relay: {
            input: context.stdin,
            stderr: context.stderr,
            stdout: context.stdout,
        },
        workingDirectory: process.cwd(),
    });
    if (result.kind === "text") {
        const text = result.text ?? "";
        context.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    } else {
        context.writeJson(result.value ?? null);
    }
}

function isInteractive(context: CliDispatchContext): boolean {
    return (
        context.outputFormat === "text" &&
        "isTTY" in context.stdin &&
        context.stdin.isTTY === true
    );
}
