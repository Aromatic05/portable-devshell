import { createInterface } from "node:readline/promises";

import type {
    InstanceContainerConfig,
    InstanceContainerPresetSchema,
    InstanceCreateDraft,
    InstanceCreateProvider,
    InstanceCreateSchema,
    InstanceCreateSummary,
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
        validateDraft: (
            draft: InstanceCreateDraft,
        ) => Promise<InstanceCreateSummary>,
    ): Promise<
        | { draft: InstanceCreateDraft; summary: InstanceCreateSummary }
        | undefined
    > {
        const readline = createInterface({ input: this.#input });
        const lines = readline[Symbol.asyncIterator]();
        try {
            const draft = await this.#collectDraft(lines, schema);
            const summary = await validateDraft(draft);
            return { draft, summary };
        } finally {
            readline.close();
        }
    }

    async #collectDraft(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
    ): Promise<InstanceCreateDraft> {
        const name = await this.#required(lines, "instance name");
        const provider = await this.#provider(lines, schema);
        return {
            name,
            provider,
            ...(await this.#providerFields(lines, schema, name, provider)),
        };
    }

    async #provider(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
    ): Promise<InstanceCreateProvider> {
        this.#output.write("Where should DevShell run?\n");
        const containerProviders = schema.providers.filter(
            (provider) => provider === "docker" || provider === "podman",
        );
        const options: Array<{
            key: "container" | InstanceCreateProvider;
            label: string;
        }> = [];
        if (schema.providers.includes("local"))
            options.push({ key: "local", label: "This computer" });
        if (schema.providers.includes("ssh"))
            options.push({ key: "ssh", label: "SSH" });
        if (containerProviders.length > 0)
            options.push({ key: "container", label: "Docker / Podman" });
        if (schema.providers.includes("reverse"))
            options.push({ key: "reverse", label: "Reverse connection" });
        for (const [index, option] of options.entries()) {
            this.#output.write(`${index + 1}. ${option.label}\n`);
        }
        const defaultKey =
            schema.defaultProvider === "docker" ||
            schema.defaultProvider === "podman"
                ? "container"
                : schema.defaultProvider;
        const defaultIndex = Math.max(
            0,
            options.findIndex((option) => option.key === defaultKey),
        );
        while (true) {
            const answer = await this.#optional(
                lines,
                "selection",
                String(defaultIndex + 1),
            );
            const numeric = Number(answer);
            const selected = Number.isInteger(numeric)
                ? options[numeric - 1]
                : options.find((option) => option.key === answer);
            if (selected?.key === "container") {
                if (containerProviders.length === 1)
                    return containerProviders[0]!;
                return await this.#containerProvider(
                    lines,
                    containerProviders,
                    schema.defaultProvider,
                );
            }
            if (selected !== undefined)
                return selected.key as InstanceCreateProvider;
            this.#output.write("Select one of the listed providers.\n");
        }
    }

    async #containerProvider(
        lines: AsyncIterator<string>,
        providers: readonly InstanceCreateProvider[],
        defaultProvider: InstanceCreateProvider,
    ): Promise<InstanceCreateProvider> {
        const fallback = providers.includes(defaultProvider)
            ? defaultProvider
            : providers[0]!;
        while (true) {
            const answer = await this.#optional(lines, "engine", fallback);
            if (providers.includes(answer as InstanceCreateProvider))
                return answer as InstanceCreateProvider;
            this.#output.write(`Engine must be ${providers.join(" or ")}.\n`);
        }
    }

    async #providerFields(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
        instanceName: string,
        provider: InstanceCreateProvider,
    ): Promise<Partial<InstanceCreateDraft>> {
        switch (provider) {
            case "local":
            case "reverse":
                return {};
            case "ssh": {
                if ((schema.sshHosts?.length ?? 0) > 0) {
                    this.#output.write(
                        `SSH config hosts: ${schema.sshHosts!.join(", ")}\n`,
                    );
                }
                const sshHosts = schema.sshHosts ?? [];
                const preferred = sshHosts.includes(instanceName)
                    ? instanceName
                    : sshHosts[0];
                const host =
                    preferred === undefined
                        ? await this.#required(lines, "ssh host")
                        : await this.#optional(lines, "ssh host", preferred);
                return { ssh: { command: `ssh ${quoteArgument(host)}` } };
            }
            case "docker":
            case "podman":
                return {
                    container: await this.#containerConfig(
                        lines,
                        schema,
                        instanceName,
                    ),
                };
        }
    }

    async #containerConfig(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
        instanceName: string,
    ): Promise<InstanceContainerConfig> {
        const mode = await this.#containerMode(lines, schema);
        switch (mode) {
            case "preset": {
                const preset = await this.#preset(lines, schema.container.presets);
                return {
                    containerName: `devshell-${instanceName}`,
                    image: preset.image,
                    mode,
                    preset: preset.preset,
                };
            }
            case "existingImage":
                return {
                    containerName: `devshell-${instanceName}`,
                    image: await this.#required(lines, "image"),
                    mode,
                };
            case "existingStoppedContainer":
                return {
                    containerName: await this.#required(
                        lines,
                        "existing container",
                    ),
                    mode,
                };
            case "dockerfile":
                return {
                    build: {
                        context: await this.#required(lines, "build context"),
                    },
                    containerName: `devshell-${instanceName}`,
                    mode,
                };
            case "compose":
                return {
                    compose: {
                        file: await this.#required(lines, "compose file"),
                        service: await this.#required(lines, "compose service"),
                    },
                    mode,
                };
        }
    }

    async #containerMode(
        lines: AsyncIterator<string>,
        schema: InstanceCreateSchema,
    ): Promise<InstanceContainerConfig["mode"]> {
        const labels: Record<InstanceContainerConfig["mode"], string> = {
            preset: "Distro preset",
            existingImage: "Existing image",
            existingStoppedContainer: "Existing stopped container",
            dockerfile: "Dockerfile",
            compose: "Compose service",
        };
        this.#output.write("Container environment\n");
        for (const [index, mode] of schema.container.modes.entries()) {
            this.#output.write(`${index + 1}. ${labels[mode]}\n`);
        }
        const defaultIndex = Math.max(
            0,
            schema.container.modes.indexOf(schema.container.defaultMode),
        );
        while (true) {
            const answer = await this.#optional(
                lines,
                "selection",
                String(defaultIndex + 1),
            );
            const numeric = Number(answer);
            const selected = Number.isInteger(numeric)
                ? schema.container.modes[numeric - 1]
                : schema.container.modes.find((mode) => mode === answer);
            if (selected !== undefined) return selected;
            this.#output.write("Select one of the listed container modes.\n");
        }
    }

    async #preset(
        lines: AsyncIterator<string>,
        presets: readonly InstanceContainerPresetSchema[],
    ): Promise<InstanceContainerPresetSchema> {
        if (presets.length === 0)
            throw new Error("No container presets are available.");
        this.#output.write(
            `Presets: ${presets.map((entry) => entry.preset).join(", ")}\n`,
        );
        while (true) {
            const answer = await this.#optional(
                lines,
                "preset",
                presets[0]!.preset,
            );
            const preset = presets.find((entry) => entry.preset === answer);
            if (preset !== undefined) return preset;
            this.#output.write("Select one of the listed presets.\n");
        }
    }

    async #required(
        lines: AsyncIterator<string>,
        label: string,
    ): Promise<string> {
        while (true) {
            const value = (await this.#ask(lines, `${label}: `)).trim();
            if (value.length > 0) return value;
            this.#output.write(`${label} is required.\n`);
        }
    }

    async #optional(
        lines: AsyncIterator<string>,
        label: string,
        defaultValue: string,
    ): Promise<string> {
        const answer = (
            await this.#ask(lines, `${label} [${defaultValue}]: `)
        ).trim();
        return answer.length === 0 ? defaultValue : answer;
    }

    async #ask(lines: AsyncIterator<string>, prompt: string): Promise<string> {
        this.#output.write(prompt);
        const next = await lines.next();
        if (next.done) throw new Error("Input closed before wizard completed.");
        return next.value;
    }
}

function quoteArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
