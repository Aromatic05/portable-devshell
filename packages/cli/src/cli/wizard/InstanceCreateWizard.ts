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
        const workspace = await this.#optional(lines, "workspace", process.cwd());

        const providerFields = await this.#providerFields(lines, provider);

        this.#output.write("MCP\n");
        const mcpEnabled = await this.#confirm(lines, "MCP enabled", schema.defaultMcpEnabled);
        const allowTools = await this.#allowTools(lines, schema.defaultAllowTools);

        this.#output.write("Security\n");
        const securityMode = await this.#optional(lines, "security mode", schema.defaultSecurityMode);

        return {
            ...(workspace.length === 0 ? {} : { workspace }),
            ...(providerFields.container === undefined ? {} : { container: providerFields.container }),
            ...(providerFields.dockerBinary === undefined ? {} : { dockerBinary: providerFields.dockerBinary }),
            ...(providerFields.podmanBinary === undefined ? {} : { podmanBinary: providerFields.podmanBinary }),
            ...(providerFields.ssh === undefined ? {} : { ssh: providerFields.ssh }),
            enabled,
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
        podmanBinary?: string;
        ssh?: {
            command?: string;
        };
    }> {
        this.#output.write("Provider\n");

        switch (provider) {
            case "local":
                return {};
            case "ssh":
                return {
                    ssh: {
                        command: await this.#required(lines, "ssh command")
                    }
                };
            case "docker":
                return {
                    container: await this.#required(lines, "docker container"),
                    dockerBinary: await this.#blankAsUndefined(lines, "docker binary")
                };
            case "podman":
                return {
                    container: await this.#required(lines, "podman container"),
                    podmanBinary: await this.#blankAsUndefined(lines, "podman binary")
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

    #renderSummary(summary: InstanceCreateSummary): void {
        const workspace =
            "workspace" in (summary as object) ? (summary as InstanceCreateSummary & { workspace?: string }).workspace : undefined;

        this.#output.write("Summary\n");
        this.#output.write(`name: ${summary.name}\n`);
        this.#output.write(`enabled: ${summary.enabled}\n`);
        this.#output.write(`provider: ${summary.provider}\n`);
        this.#output.write(`workspace: ${workspace ?? ""}\n`);

        if (summary.ssh?.command !== undefined) {
            this.#output.write(`ssh command: ${summary.ssh.command}\n`);
        }

        if (summary.container !== undefined) {
            this.#output.write(`container: ${summary.container}\n`);
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
        this.#output.write(`security mode: ${summary.security.mode}\n`);
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
