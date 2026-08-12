import { createInterface } from "node:readline/promises";

import type {
    ApprovalPolicy,
    ApprovalPolicyMode,
    ConfigInstanceMcpDraft,
    ControlInstanceLogsConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthMode,
    InstanceContainerConfig,
    InstanceContainerMountConfig,
    InstanceContainerPresetSchema,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue
} from "@portable-devshell/shared";

export interface CliWizardInstanceCreateOptions {
    input?: NodeJS.ReadableStream;
    output?: { write(chunk: string): void };
}

export class CliWizardInstanceCreate {
    readonly #input: NodeJS.ReadableStream;
    readonly #output: { write(chunk: string): void };

    constructor(options: CliWizardInstanceCreateOptions = {}) {
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

        const providerFields = await this.#providerFields(lines, schema, name, provider);

        this.#output.write("MCP\n");
        const mcpEnabled = await this.#confirm(lines, "MCP enabled", schema.defaultMcpEnabled);
        const mcpAuth = mcpEnabled ? await this.#mcpAuth(lines) : { auth: "none" as const };
        const mcpGroups = await this.#stringList(lines, "MCP tool groups", schema.defaultMcpGroups);
        const mcpCapabilities = await this.#stringList(lines, "MCP capabilities", schema.defaultMcpCapabilities);

        this.#output.write("Security\n");
        const securityMode = await this.#securityMode(lines, schema);
        const approvalPolicy = await this.#approvalPolicy(lines);

        this.#output.write("Runtime\n");
        const env = await this.#instanceEnv(lines);
        const logs = await this.#logs(lines);
        const tools = await this.#tools(lines);

        return {
            ...(providerFields.container === undefined ? {} : { container: providerFields.container }),
            ...(providerFields.dockerBinary === undefined ? {} : { dockerBinary: providerFields.dockerBinary }),
            ...(providerFields.podmanBinary === undefined ? {} : { podmanBinary: providerFields.podmanBinary }),
            ...(providerFields.ssh === undefined ? {} : { ssh: providerFields.ssh }),
            ...(approvalPolicy.mode === "disabled" && approvalPolicy.rules === undefined ? {} : { approvalPolicy }),
            ...(env === undefined ? {} : { env }),
            ...(logs === undefined ? {} : { logs }),
            ...(tools === undefined ? {} : { tools }),
            enabled,
            mcp: {
                ...mcpAuth,
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

            if (schema.providers.includes(value as InstanceCreateDraft["provider"])) {
                return value as InstanceCreateDraft["provider"];
            }

            this.#output.write(`provider must be one of ${schema.providers.join(", ")}.\n`);
    }
    }

    async #mcpAuth(lines: AsyncIterator<string>): Promise<ConfigInstanceMcpDraft> {
        const auth = await this.#choice<ControlMcpAuthMode>(
            lines,
            "MCP auth",
            ["none", "token", "oauth2"],
            "none"
        );
        switch (auth) {
            case "none":
                return { auth };
            case "token":
                return {
                    auth,
                    token: await this.#secretRequired(lines, "MCP token")
                };
            case "oauth2": {
                const resourceName = await this.#required(lines, "OAuth resource name");
                const requiredScopes = await this.#stringList(lines, "OAuth required scopes", ["mcp"]);
                const documentationUrl = await this.#blankAsUndefined(lines, "OAuth documentation URL");
                return {
                    auth,
                    oauth2: {
                        ...(documentationUrl === undefined ? {} : { documentationUrl }),
                        requiredScopes,
                        resourceName
                    }
                };
            }
        }
    }

    async #approvalPolicy(lines: AsyncIterator<string>): Promise<ApprovalPolicy> {
        const mode = await this.#choice<ApprovalPolicyMode>(
            lines,
            "approval mode",
            ["disabled", "allow", "ask", "deny"],
            "disabled"
        );
        if (mode === "disabled") {
            return { mode };
        }
        const rules = await this.#jsonOptional<ApprovalPolicy["rules"]>(
            lines,
            "approval rules JSON",
            (value) => Array.isArray(value),
            "approval rules must be a JSON array."
        );
        return {
            mode,
            ...(rules === undefined ? {} : { rules })
        };
    }

    async #instanceEnv(lines: AsyncIterator<string>): Promise<Record<string, string> | undefined> {
        const env: Record<string, string> = {};
        while (await this.#confirm(lines, "add instance env", false)) {
            const key = await this.#required(lines, "instance env key");
            env[key] = await this.#secretRequired(lines, "instance env value");
        }
        return Object.keys(env).length === 0 ? undefined : env;
    }

    async #logs(lines: AsyncIterator<string>): Promise<ControlInstanceLogsConfig | undefined> {
        if (!(await this.#confirm(lines, "configure log limits", false))) {
            return undefined;
        }
        const retentionDays = await this.#positiveIntegerOptional(lines, "log retention days");
        const maxBytes = await this.#positiveIntegerOptional(lines, "log max bytes");
        const eventBufferSize = await this.#positiveIntegerOptional(lines, "log event buffer size");
        const result = {
            ...(eventBufferSize === undefined ? {} : { eventBufferSize }),
            ...(maxBytes === undefined ? {} : { maxBytes }),
            ...(retentionDays === undefined ? {} : { retentionDays })
        };
        return Object.keys(result).length === 0 ? undefined : result;
    }

    async #tools(lines: AsyncIterator<string>): Promise<ControlInstanceToolsConfig | undefined> {
        if (!(await this.#confirm(lines, "configure tool scheduler", false))) {
            return undefined;
        }
        const maxRunning = await this.#positiveIntegerOptional(lines, "scheduler max running");
        const maxRunningPerSession = await this.#positiveIntegerOptional(lines, "scheduler max running per session");
        const queueDepth = await this.#positiveIntegerOptional(lines, "scheduler queue depth");
        const queueDepthPerSession = await this.#positiveIntegerOptional(lines, "scheduler queue depth per session");
        const queueTimeoutMs = await this.#positiveIntegerOptional(lines, "scheduler queue timeout ms");
        const byTool = await this.#jsonOptional<NonNullable<NonNullable<ControlInstanceToolsConfig["scheduler"]>["byTool"]>>(
            lines,
            "scheduler by-tool JSON",
            isJsonObject,
            "scheduler by-tool limits must be a JSON object."
        );
        const scheduler = {
            ...(byTool === undefined ? {} : { byTool }),
            ...(maxRunning === undefined ? {} : { maxRunning }),
            ...(maxRunningPerSession === undefined ? {} : { maxRunningPerSession }),
            ...(queueDepth === undefined ? {} : { queueDepth }),
            ...(queueDepthPerSession === undefined ? {} : { queueDepthPerSession }),
            ...(queueTimeoutMs === undefined ? {} : { queueTimeoutMs })
        };
        return Object.keys(scheduler).length === 0 ? undefined : { scheduler };
    }

    async #securityMode(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema
    ): Promise<InstanceCreateSchema["defaultSecurityMode"]> {
        while (true) {
            const value = await this.#optional(lines, "security mode (disabled | workspace)", schema.defaultSecurityMode);
            if (value === "disabled" || value === "workspace") {
                return value;
            }
            this.#output.write("security mode must be disabled or workspace.\n");
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
            const value = await this.#secretRequired(lines, "env value");
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

    async #choice<T extends string>(
        lines: AsyncIterator<string>,
        label: string,
        values: readonly T[],
        defaultValue: T
    ): Promise<T> {
        while (true) {
            const answer = await this.#optional(lines, `${label} (${values.join(" | ")})`, defaultValue);
            if (values.includes(answer as T)) {
                return answer as T;
            }
            this.#output.write(`${label} must be one of ${values.join(", ")}.\n`);
        }
    }

    async #positiveIntegerOptional(lines: AsyncIterator<string>, label: string): Promise<number | undefined> {
        while (true) {
            const value = await this.#blankAsUndefined(lines, label);
            if (value === undefined) {
                return undefined;
            }
            const parsed = Number(value);
            if (Number.isSafeInteger(parsed) && parsed > 0) {
                return parsed;
            }
            this.#output.write(`${label} must be a positive integer.\n`);
        }
    }

    async #jsonOptional<T>(
        lines: AsyncIterator<string>,
        label: string,
        validate: (value: JsonValue) => boolean,
        invalidMessage: string
    ): Promise<T | undefined> {
        while (true) {
            const raw = await this.#blankAsUndefined(lines, label);
            if (raw === undefined) {
                return undefined;
            }
            try {
                const value = JSON.parse(raw) as JsonValue;
                if (validate(value)) {
                    return value as T;
                }
            } catch {
                // Report one stable validation message below.
            }
            this.#output.write(`${invalidMessage}\n`);
        }
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

    async #secretRequired(lines: AsyncIterator<string>, label: string): Promise<string> {
        while (true) {
            const value = (await this.#askSecret(lines, `${label}: `)).trim();
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
        this.#output.write(`mcp auth: ${summary.mcp.auth.mode}\n`);
        if (summary.mcp.auth.oauth2 !== undefined) {
            this.#output.write(`oauth resource: ${summary.mcp.auth.oauth2.resourceName}\n`);
            this.#output.write(`oauth scopes: ${summary.mcp.auth.oauth2.requiredScopes.join(",")}\n`);
            if (summary.mcp.auth.oauth2.documentationUrl !== undefined) {
                this.#output.write(`oauth documentation: ${summary.mcp.auth.oauth2.documentationUrl}\n`);
            }
        }
        this.#output.write(`mcp path: ${summary.mcp.path}\n`);
        this.#output.write(`MCP groups: ${summary.mcp.tools.groups.join(",")}\n`);
        this.#output.write(`MCP capabilities: ${summary.mcp.tools.capabilities.join(",")}\n`);
        this.#output.write(`security mode: ${summary.security.mode}\n`);
        this.#output.write(`approval mode: ${summary.approvalPolicy?.mode ?? "disabled"}\n`);
        if ((summary.approvalPolicy?.rules?.length ?? 0) > 0) {
            this.#output.write(`approval rules: ${summary.approvalPolicy!.rules!.length}\n`);
        }
        if (summary.env !== undefined) {
            this.#output.write(`instance env keys: ${Object.keys(summary.env).sort().join(",")}\n`);
        }
        if (summary.logs !== undefined) {
            this.#output.write(`logs: ${JSON.stringify(summary.logs)}\n`);
        }
        if (summary.tools?.scheduler !== undefined) {
            this.#output.write(`tool scheduler: ${JSON.stringify(summary.tools.scheduler)}\n`);
        }
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
            this.#output.write(`container env keys: ${Object.keys(container.env).sort().join(", ")}\n`);
        }
    }

    async #askSecret(lines: AsyncIterator<string>, prompt: string): Promise<string> {
        const input = this.#input as NodeJS.ReadableStream & {
            isTTY?: boolean;
            setRawMode?(mode: boolean): void;
        };
        const hideInput = input.isTTY === true && typeof input.setRawMode === "function";
        if (hideInput) {
            input.setRawMode!(true);
        }
        try {
            const value = await this.#ask(lines, prompt);
            if (hideInput) {
                this.#output.write("\n");
            }
            return value;
        } finally {
            if (hideInput) {
                input.setRawMode!(false);
            }
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

function isJsonObject(value: JsonValue): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
