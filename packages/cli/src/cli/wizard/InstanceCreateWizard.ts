import { createInterface, type Interface } from "node:readline/promises";

import type { InstanceCreateDraft, InstanceCreateSchema, InstanceCreateSummary } from "@portable-devshell/shared";

export interface InstanceCreateWizardOptions {
    input?: NodeJS.ReadableStream;
    output?: { write(chunk: string): void };
}

export class InstanceCreateWizard {
    readonly #input: NodeJS.ReadableStream;
    readonly #output: { write(chunk: string): void };

    constructor(options: InstanceCreateWizardOptions = {}) {
        this.#input = options.input ?? process.stdin;
        this.#output = options.output ?? process.stdout;
    }

    async run(
        schema: InstanceCreateSchema,
        validateDraft: (draft: InstanceCreateDraft) => Promise<InstanceCreateSummary>
    ): Promise<{ draft: InstanceCreateDraft; summary: InstanceCreateSummary } | undefined> {
        const readline = createInterface({
            input: this.#input
        });
        const lines = readline[Symbol.asyncIterator]();

        try {
            const draft = await this.#collectDraft(readline, lines, schema);
            const summary = await validateDraft(draft);

            this.#renderSummary(summary);

            if (!(await this.#confirm(lines, "Create this instance", true))) {
                this.#output.write("Instance creation cancelled.\n");
                return undefined;
            }

            return { draft, summary };
        } finally {
            readline.close();
        }
    }

    async #collectDraft(
        readline: Interface,
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema
    ): Promise<InstanceCreateDraft> {
        this.#output.write("Basic\n");
        const name = await this.#required(lines, "instance name");
        const enabled = await this.#confirm(lines, "enabled", schema.defaultEnabled);
        const provider = await this.#provider(lines, schema);
        const defaultWorkspace = await this.#optional(lines, "default workspace", process.cwd());

        this.#output.write("Worker\n");
        const workerBinaryPath = await this.#optional(lines, "worker binary path", "");

        const providerFields = await this.#providerFields(lines, provider);

        this.#output.write("MCP\n");
        const mcpEnabled = await this.#confirm(lines, "MCP enabled", schema.defaultMcpEnabled);
        const allowTools = await this.#allowTools(lines, schema.defaultAllowTools);

        this.#output.write("Logs and Security\n");
        const eventBufferSize = await this.#integer(lines, "event buffer size", schema.defaultEventBufferSize);
        const retentionDays = await this.#integer(lines, "retention days", schema.defaultRetentionDays);
        const securityMode = await this.#optional(lines, "security mode", schema.defaultSecurityMode);

        this.#output.write("Environment\n");
        const env = await this.#envEntries(lines);

        return {
            ...(defaultWorkspace.length === 0 ? {} : { defaultWorkspace }),
            ...(workerBinaryPath.length === 0 ? {} : { workerBinaryPath }),
            ...(providerFields.container === undefined ? {} : { container: providerFields.container }),
            ...(providerFields.dockerBinary === undefined ? {} : { dockerBinary: providerFields.dockerBinary }),
            ...(providerFields.host === undefined ? {} : { host: providerFields.host }),
            ...(providerFields.podmanBinary === undefined ? {} : { podmanBinary: providerFields.podmanBinary }),
            ...(providerFields.remoteCwd === undefined ? {} : { remoteCwd: providerFields.remoteCwd }),
            ...(providerFields.sshBinary === undefined ? {} : { sshBinary: providerFields.sshBinary }),
            ...(env === undefined ? {} : { env }),
            enabled,
            logs: {
                eventBufferSize,
                retentionDays
            },
            mcp: {
                allowTools,
                enabled: mcpEnabled
            },
            name,
            provider,
            security: {
                mode: securityMode
            }
        };
    }

    async #provider(lines: AsyncIterator<string>, schema: InstanceCreateSchema): Promise<InstanceCreateDraft["provider"]> {
        while (true) {
            const value = (await this.#optional(lines, `provider (${schema.providers.join(" | ")})`, schema.defaultProvider)).trim();

            if (value === "local" || value === "ssh" || value === "docker" || value === "podman") {
                return value;
            }

            this.#output.write("provider must be one of local, ssh, docker, podman.\n");
        }
    }

    async #providerFields(
        lines: AsyncIterator<string>,
        provider: InstanceCreateDraft["provider"]
    ): Promise<{
        container?: string;
        dockerBinary?: string;
        host?: string;
        podmanBinary?: string;
        remoteCwd?: string;
        sshBinary?: string;
    }> {
        this.#output.write("Provider\n");

        switch (provider) {
            case "local":
                return {};
            case "ssh":
                return {
                    host: await this.#required(lines, "ssh host"),
                    remoteCwd: await this.#blankAsUndefined(lines, "ssh remote cwd"),
                    sshBinary: await this.#blankAsUndefined(lines, "ssh binary")
                };
            case "docker":
                return {
                    container: await this.#required(lines, "docker container"),
                    dockerBinary: await this.#blankAsUndefined(lines, "docker binary"),
                    remoteCwd: await this.#blankAsUndefined(lines, "docker remote cwd")
                };
            case "podman":
                return {
                    container: await this.#required(lines, "podman container"),
                    podmanBinary: await this.#blankAsUndefined(lines, "podman binary"),
                    remoteCwd: await this.#blankAsUndefined(lines, "podman remote cwd")
                };
        }
    }

    async #allowTools(lines: AsyncIterator<string>, defaults: readonly string[]): Promise<string[]> {
        const raw = await this.#optional(lines, "allowed tools (comma or space separated)", defaults.join(","));

        if (raw.trim().length === 0) {
            return [...defaults];
        }

        return [...new Set(raw.split(/[,\s]+/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
    }

    async #envEntries(lines: AsyncIterator<string>): Promise<Record<string, string> | undefined> {
        this.#output.write("Enter KEY=VALUE pairs, one per line. Submit an empty line to finish.\n");
        const env: Record<string, string> = {};

        while (true) {
            const line = await this.#ask(lines, "env> ");
            const trimmed = line.trim();

            if (trimmed.length === 0) {
                break;
            }

            const separator = trimmed.indexOf("=");

            if (separator <= 0) {
                this.#output.write("env entry must use KEY=VALUE format.\n");
                continue;
            }

            env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
        }

        return Object.keys(env).length === 0 ? undefined : env;
    }

    async #confirm(lines: AsyncIterator<string>, label: string, defaultValue: boolean): Promise<boolean> {
        const suffix = defaultValue ? "[Y/n]" : "[y/N]";

        while (true) {
            const answer = (await this.#ask(lines, `${label} ${suffix}: `)).trim().toLowerCase();

            if (answer.length === 0) {
                return defaultValue;
            }

            if (answer === "y" || answer === "yes") {
                return true;
            }

            if (answer === "n" || answer === "no") {
                return false;
            }

            this.#output.write("Please answer yes or no.\n");
        }
    }

    async #required(lines: AsyncIterator<string>, label: string): Promise<string> {
        while (true) {
            const value = (await this.#ask(lines, `${label}: `)).trim();

            if (value.length > 0) {
                return value;
            }

            this.#output.write(`${label} is required.\n`);
        }
    }

    async #optional(lines: AsyncIterator<string>, label: string, defaultValue: string): Promise<string> {
        const answer = await this.#ask(lines, `${label}${defaultValue.length > 0 ? ` [${defaultValue}]` : ""}: `);
        const trimmed = answer.trim();
        return trimmed.length === 0 ? defaultValue : trimmed;
    }

    async #blankAsUndefined(lines: AsyncIterator<string>, label: string): Promise<string | undefined> {
        const value = (await this.#ask(lines, `${label}: `)).trim();
        return value.length === 0 ? undefined : value;
    }

    async #integer(lines: AsyncIterator<string>, label: string, defaultValue: number): Promise<number> {
        while (true) {
            const answer = await this.#optional(lines, label, String(defaultValue));
            const parsed = Number(answer);

            if (Number.isInteger(parsed) && parsed >= 0) {
                return parsed;
            }

            this.#output.write(`${label} must be a non-negative integer.\n`);
        }
    }

    #renderSummary(summary: InstanceCreateSummary): void {
        this.#output.write("Summary\n");
        this.#output.write(`name: ${summary.name}\n`);
        this.#output.write(`enabled: ${summary.enabled}\n`);
        this.#output.write(`provider: ${summary.provider}\n`);
        this.#output.write(`default workspace: ${summary.defaultWorkspace ?? ""}\n`);
        this.#output.write(`worker binary path: ${summary.workerBinaryPath ?? ""}\n`);

        if (summary.host !== undefined) {
            this.#output.write(`host: ${summary.host}\n`);
        }

        if (summary.container !== undefined) {
            this.#output.write(`container: ${summary.container}\n`);
        }

        if (summary.remoteCwd !== undefined) {
            this.#output.write(`remote cwd: ${summary.remoteCwd}\n`);
        }

        if (summary.sshBinary !== undefined) {
            this.#output.write(`ssh binary: ${summary.sshBinary}\n`);
        }

        if (summary.dockerBinary !== undefined) {
            this.#output.write(`docker binary: ${summary.dockerBinary}\n`);
        }

        if (summary.podmanBinary !== undefined) {
            this.#output.write(`podman binary: ${summary.podmanBinary}\n`);
        }

        this.#output.write(`mcp enabled: ${summary.mcp.enabled}\n`);
        this.#output.write(`mcp path: ${summary.mcp.path}\n`);
        this.#output.write(`allowed tools: ${summary.mcp.allowTools.join(",")}\n`);
        this.#output.write(`event buffer size: ${summary.logs.eventBufferSize}\n`);
        this.#output.write(`retention days: ${summary.logs.retentionDays}\n`);
        this.#output.write(`security mode: ${summary.security.mode}\n`);
        this.#output.write(`env entries: ${Object.keys(summary.env ?? {}).length}\n`);
    }

    async #ask(lines: AsyncIterator<string>, prompt: string): Promise<string> {
        this.#output.write(prompt);
        const next = await lines.next();

        if (next.done) {
            throw new Error("Input closed.");
        }

        return next.value;
    }
}
