import { createInterface } from "node:readline/promises";

import {
    createRemoteError,
    controlErrorCodes,
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
        if (approvalToken !== undefined)
            context.stderr.write(`OAuth2 approval\n  ${approvalToken}\n`);
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
            throw createRemoteError({
                code: controlErrorCodes.instanceAlreadyExists,
                details: {
                    instance: defaultInitialInstanceName,
                    provider: collision.provider,
                },
                message: `Instance ${defaultInitialInstanceName} already exists with provider ${collision.provider}; refusing to replace it with the default local instance.`,
                retryable: false,
            });
        }
        await context.clients.instance.createInstance({
            mcp: {
                auth: "oauth2",
                contextMode: "openai-session",
                oauth2: {
                    requiredScopes: ["mcp"],
                    resourceName: defaultInitialInstanceName,
                },
            },
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
        snapshot = await context.clients.runtime(localInstance.name).start({
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
    if (freshLike && isInteractive(context) && (await hasAccessCommand(context)))
        await offerRemoteAccess(context, localInstance.mcp.path);
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
    } else if (result.mcpEnabled) {
        lines.push("", "MCP", "  enabled (public URL not configured)");
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

async function offerRemoteAccess(context: CliDispatchContext, endpointPath: string): Promise<void> {
    const readline = createInterface({ input: context.stdin });
    const lines = readline[Symbol.asyncIterator]();
    async function readLine(prompt: string): Promise<string> {
        context.stdout.write(prompt);
        const next = await lines.next();
        return next.done ? "" : next.value.trim();
    }
    let answer: string;
    try {
        answer = (await readLine([
            "MCP access", "1. Already public", "2. Cloudflare Tunnel",
            "3. SSH reverse", "4. Configure later", "selection [4]: ",
        ].join("\n"))).toLowerCase();
        if (answer === "1" || answer === "public") {
            while (true) {
                const value = await readLine("Public base URL (e.g. https://devshell.example, without the Instance MCP path; blank to skip): ");
                if (value.length === 0) return;
                let url: URL;
                try {
                    url = new URL(value);
                } catch {
                    context.stdout.write("Enter an absolute HTTP(S) base URL.\n");
                    continue;
                }
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                    context.stdout.write("Use an HTTP(S) base URL without credentials, query or fragment.\n");
                    continue;
                }
                const base = `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
                if (url.pathname.replace(/\/+$/u, "").endsWith("/mcp") || base.endsWith(endpointPath)) {
                    context.stdout.write(`Enter the base URL without the Instance endpoint ${endpointPath}.\n`);
                    continue;
                }
                await context.clients.config.update({ mcp: { publicBaseUrl: base } });
                context.stdout.write(`MCP public base URL configured: ${base}\nMCP endpoint: ${joinEndpoint(base, endpointPath)}\n`);
                return;
            }
        }
    } finally {
        readline.close();
    }
    if (answer === "2" || answer === "cloudflare")
        await runAccessCommand(context, ["cloudflare"]);
    if (answer === "3" || answer === "ssh")
        await runAccessCommand(context, ["ssh"]);
}

async function runAccessCommand(
    context: CliDispatchContext,
    args: readonly string[],
): Promise<void> {
    const result = await context.clients.cli.command("access", args, {
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

async function hasAccessCommand(context: CliDispatchContext): Promise<boolean> {
    try {
        return (await context.clients.cli.commands()).some(
            (command) => command.id === "access",
        );
    } catch {
        return false;
    }
}

function isInteractive(context: CliDispatchContext): boolean {
    return (
        context.outputFormat === "text" &&
        "isTTY" in context.stdin &&
        context.stdin.isTTY === true
    );
}
