import { createInterface } from "node:readline/promises";

import type {
    InstanceContainerConfig,
    InstanceContainerMountConfig,
    InstanceContainerPresetSchema,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary
} from "@portable-devshell/shared";

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
            const draft = await this.#collectDraft(lines, schema);
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

    async #collectDraft(lines: AsyncIterator<string>, schema: InstanceCreateSchema): Promise<InstanceCreateDraft> {
        this.#output.write("Basic\n");
        const name = await this.#required(lines, "instance name");
        const enabled = await this.#confirm(lines, "enabled", schema.defaultEnabled);
        const provider = await this.#provider(lines, schema);
        const workspace = await this.#optional(lines, "workspace", process.cwd());

        const providerFields = await this.#providerFields(lines, schema, name, provider);

        this.#output.write("MCP\n");
        const mcpEnabled = await this.#confirm(lines, "MCP enabled", schema.defaultMcpEnabled);
        const mcpGroups = await this.#stringList(lines, "MCP tool groups", schema.defaultMcpGroups);
        const mcpCapabilities = await this.#stringList(lines, "MCP capabilities", schema.defaultMcpCapabilities);

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
                enabled: mcpEnabled,
                tools: {
                    capabilities: mcpCapabilities as InstanceCreateDraft["mcp"] extends { tools?: { capabilities?: infer T } } ? T : never,
                    groups: mcpGroups
                }
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

            if (value === "local" || value === "ssh" || value === "docker" || value === "podman" || value === "reverse") {
                return value;
            }

            this.#output.write("provider must be one of local, ssh, docker, podman, reverse.\n");
    }
    }

    async #providerFields(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
        instanceName: string,
        provider: InstanceCreateDraft["provider"]
    ): Promise<{
        container?: InstanceContainerConfig;
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
            case "reverse":
                return {};
            case "ssh":
                return {
                    ssh: {
                        command: await this.#required(lines, "ssh command")
                    }
                };
            case "docker":
                return {
                    container: await this.#containerConfig(lines, schema, instanceName),
                    dockerBinary: await this.#blankAsUndefined(lines, "docker binary")
                };
            case "podman":
                return {
                    container: await this.#containerConfig(lines, schema, instanceName),
                    podmanBinary: await this.#blankAsUndefined(lines, "podman binary")
                };
        }
    }

    async #containerConfig(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
        instanceName: string
    ): Promise<InstanceContainerConfig> {
        this.#output.write("Container\n");
        const mode = await this.#containerMode(lines, schema);
        const defaultContainerName = `devshell-${instanceName}`;

        switch (mode) {
            case "preset": {
                const preset = await this.#preset(lines, schema.container.presets);
                return {
                    ...(await this.#managedContainerFields(lines, defaultContainerName)),
                    image: await this.#optional(lines, "preset image", preset.image),
                    mode,
                    preset: preset.preset
                };
            }
            case "dockerfile":
                return {
                    ...(await this.#managedContainerFields(lines, defaultContainerName)),
                    build: {
                        context: await this.#required(lines, "build context"),
                        dockerfile: await this.#blankAsUndefined(lines, "dockerfile path"),
                        tag: (await this.#blankAsUndefined(lines, "build tag")) ?? `devshell-${instanceName}:latest`
                    },
                    mode
                };
            case "compose":
                return {
                    compose: {
                        file: await this.#required(lines, "compose file"),
                        projectName: await this.#blankAsUndefined(lines, "compose project name"),
                        service: await this.#required(lines, "compose service")
                    },
                    mode
                };
            case "existingImage":
                return {
                    ...(await this.#managedContainerFields(lines, defaultContainerName)),
                    image: await this.#required(lines, "existing image"),
                    mode
                };
            case "existingStoppedContainer":
                return {
                    adoptLifecycle: await this.#confirm(lines, "stop adopted container on instance stop", false),
                    containerName: await this.#required(lines, "existing stopped container name"),
                    mode
                };
        }
    }

    async #containerMode(lines: AsyncIterator<string>, schema: InstanceCreateSchema): Promise<InstanceContainerConfig["mode"]> {
        const options = [
            { label: "Create from distro preset", mode: "preset" },
            { label: "Build from Dockerfile", mode: "dockerfile" },
            { label: "Use compose service", mode: "compose" },
            { label: "Use existing image", mode: "existingImage" },
            { label: "Adopt existing stopped container", mode: "existingStoppedContainer" }
        ] as const satisfies ReadonlyArray<{ label: string; mode: InstanceContainerConfig["mode"] }>;
        const defaultIndex = options.findIndex((entry) => entry.mode === schema.container.defaultMode);

        this.#output.write("container setup\n");
        for (const [index, option] of options.entries()) {
            this.#output.write(`${index + 1}. ${option.label}\n`);
        }

        while (true) {
            const answer = await this.#optional(lines, "selection", String(defaultIndex + 1));
            const parsed = Number(answer);
            const selected = Number.isInteger(parsed) ? options[parsed - 1] : undefined;

            if (selected !== undefined) {
                return selected.mode;
            }

            this.#output.write("selection must be 1-5.\n");
        }
    }

    async #preset(
        lines: AsyncIterator<string>,
        presets: readonly InstanceContainerPresetSchema[]
    ): Promise<InstanceContainerPresetSchema> {
        this.#output.write(`presets: ${presets.map((entry) => entry.preset).join(", ")}\n`);

        while (true) {
            const answer = await this.#optional(lines, "preset", presets[0]?.preset ?? "");
            const preset = presets.find((entry) => entry.preset === answer);

            if (preset !== undefined) {
                return preset;
            }

            this.#output.write("preset must match one of the listed presets.\n");
        }
    }

    async #managedContainerFields(
        lines: AsyncIterator<string>,
        defaultContainerName: string
    ): Promise<{
        containerName: string;
        env?: Record<string, string>;
        mounts?: InstanceContainerMountConfig[];
        network?: string;
        user?: string;
    }> {
        const containerName = await this.#optional(lines, "container name", defaultContainerName);
        const user = await this.#blankAsUndefined(lines, "container user");
        const network = await this.#blankAsUndefined(lines, "container network");
        const mounts = await this.#mounts(lines);
        const env = await this.#containerEnv(lines);

        return {
            containerName,
            ...(env === undefined ? {} : { env }),
            ...(mounts === undefined ? {} : { mounts }),
            ...(network === undefined ? {} : { network }),
            ...(user === undefined ? {} : { user })
        };
    }

    async #mounts(lines: AsyncIterator<string>): Promise<InstanceContainerMountConfig[] | undefined> {
        const mounts: InstanceContainerMountConfig[] = [];

        while (await this.#confirm(lines, "add bind mount", false)) {
            const source = await this.#required(lines, "mount source");
            const target = await this.#required(lines, "mount target");

            while (true) {
                const mode = await this.#optional(lines, "mount mode", "rw");
                if (mode === "ro" || mode === "rw") {
                    mounts.push({
                        mode,
                        source,
                        target
                    });
                    break;
                }

                this.#output.write("mount mode must be ro or rw.\n");
            }
        }

        return mounts.length === 0 ? undefined : mounts;
    }

    async #containerEnv(lines: AsyncIterator<string>): Promise<Record<string, string> | undefined> {
        const env: Record<string, string> = {};

        while (await this.#confirm(lines, "add container env", false)) {
            const key = await this.#required(lines, "env key");
            const value = await this.#required(lines, "env value");
            env[key] = value;
        }

        return Object.keys(env).length === 0 ? undefined : env;
    }

    async #stringList(lines: AsyncIterator<string>, label: string, defaults: readonly string[]): Promise<string[]> {
        const raw = await this.#optional(lines, `${label} (comma or space separated)`, defaults.join(","));

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
        this.#output.write("Summary\n");
        this.#output.write(`name: ${summary.name}\n`);
        this.#output.write(`enabled: ${summary.enabled}\n`);
        this.#output.write(`provider: ${summary.provider}\n`);
        this.#output.write(`workspace: ${summary.workspace ?? ""}\n`);

        if (summary.ssh?.command !== undefined) {
            this.#output.write(`ssh command: ${summary.ssh.command}\n`);
        }

        if (summary.container !== undefined) {
            this.#renderContainerSummary(summary.container);
        }

        if (summary.dockerBinary !== undefined) {
            this.#output.write(`docker binary: ${summary.dockerBinary}\n`);
        }

        if (summary.podmanBinary !== undefined) {
            this.#output.write(`podman binary: ${summary.podmanBinary}\n`);
        }

        this.#output.write(`mcp enabled: ${summary.mcp.enabled}\n`);
        this.#output.write(`mcp path: ${summary.mcp.path}\n`);
        this.#output.write(`MCP groups: ${summary.mcp.tools.groups.join(",")}\n`);
        this.#output.write(`MCP capabilities: ${summary.mcp.tools.capabilities.join(",")}\n`);
        this.#output.write(`security mode: ${summary.security.mode}\n`);
    }

    #renderContainerSummary(container: InstanceContainerConfig): void {
        this.#output.write(`container mode: ${container.mode}\n`);

        switch (container.mode) {
            case "preset":
                this.#output.write(`container preset: ${container.preset}\n`);
                this.#output.write(`container image: ${container.image}\n`);
                this.#output.write(`container name: ${container.containerName}\n`);
                this.#renderManagedContainerExtras(container);
                return;
            case "dockerfile":
                this.#output.write(`container name: ${container.containerName}\n`);
                this.#output.write(`build context: ${container.build.context}\n`);
                if (container.build.dockerfile !== undefined) {
                    this.#output.write(`dockerfile path: ${container.build.dockerfile}\n`);
                }
                if (container.build.tag !== undefined) {
                    this.#output.write(`build tag: ${container.build.tag}\n`);
                }
                this.#renderManagedContainerExtras(container);
                return;
            case "compose":
                this.#output.write(`compose file: ${container.compose.file}\n`);
                this.#output.write(`compose service: ${container.compose.service}\n`);
                if (container.compose.projectName !== undefined) {
                    this.#output.write(`compose project: ${container.compose.projectName}\n`);
                }
                return;
            case "existingImage":
                this.#output.write(`container image: ${container.image}\n`);
                this.#output.write(`container name: ${container.containerName}\n`);
                this.#renderManagedContainerExtras(container);
                return;
            case "existingStoppedContainer":
                this.#output.write(`container name: ${container.containerName}\n`);
                this.#output.write(`adopt lifecycle: ${container.adoptLifecycle === true}\n`);
                return;
        }
    }

    #renderManagedContainerExtras(
        container: Extract<InstanceContainerConfig, { mode: "preset" | "dockerfile" | "existingImage" }>
    ): void {
        if (container.user !== undefined) {
            this.#output.write(`container user: ${container.user}\n`);
        }

        if (container.network !== undefined) {
            this.#output.write(`container network: ${container.network}\n`);
        }

        if ((container.mounts?.length ?? 0) > 0) {
            this.#output.write(`container mounts: ${container.mounts?.map((mount) => `${mount.source}:${mount.target}:${mount.mode}`).join(", ")}\n`);
        }

        if (container.env !== undefined && Object.keys(container.env).length > 0) {
            this.#output.write(`container env: ${Object.entries(container.env).map(([key, value]) => `${key}=${value}`).join(", ")}\n`);
        }
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
