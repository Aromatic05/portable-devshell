import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import type {
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "@portable-devshell/shared";

import { CliWizardInstanceCreate } from "../../src/command/instance/create/Wizard.js";

const schema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: [
            "preset",
            "dockerfile",
            "compose",
            "existingImage",
            "existingStoppedContainer",
        ],
        presets: [
            { image: "archlinux:latest", preset: "arch" },
            { image: "debian:stable", preset: "debian" },
        ],
    },
    defaultEnabled: true,
    defaultMcpContextMode: "explicit",
    defaultMcpEnabled: true,
    defaultModelExtensions: ["instance"],
    defaultProvider: "local",
    defaultSecurityMode: "disabled",
    providers: ["local", "ssh", "docker", "podman", "reverse"],
    sshHosts: ["build-server", "remote-one"],
};

test("instance wizard creates a minimal local draft", async () => {
    const output = createBuffer();
    let validated: InstanceCreateDraft | undefined;
    const result = await createWizard(["local-one", ""], output).run(
        schema,
        async (draft) => {
            validated = draft;
            return summaryFor(draft);
        },
    );

    assert.deepEqual(validated, { name: "local-one", provider: "local" });
    assert.deepEqual(result?.draft, validated);
    assert.doesNotMatch(output.flush(), /MCP|Security|approval|scheduler/iu);
});

test("instance wizard uses SSH config hosts instead of asking for a raw command", async () => {
    const output = createBuffer();
    const sshSchema = { ...schema, defaultProvider: "ssh" as const };
    const result = await createWizard(["remote-one", "", ""], output).run(
        sshSchema,
        async (draft) => summaryFor(draft),
    );

    assert.deepEqual(result?.draft, {
        name: "remote-one",
        provider: "ssh",
        ssh: { command: "ssh 'remote-one'" },
    });
    assert.match(output.flush(), /SSH config hosts: build-server, remote-one/u);
});

test("instance wizard asks only for the selected container source", async () => {
    const output = createBuffer();
    const result = await createWizard(
        ["docker-one", "3", "docker", "existingImage", "ubuntu:24.04"],
        output,
    ).run(schema, async (draft) => summaryFor(draft));

    assert.deepEqual(result?.draft, {
        container: {
            containerName: "devshell-docker-one",
            image: "ubuntu:24.04",
            mode: "existingImage",
        },
        name: "docker-one",
        provider: "docker",
    });
});

test("instance wizard validates a preset with no optional container prompts", async () => {
    const output = createBuffer();
    const result = await createWizard(
        ["podman-one", "3", "podman", "", "debian"],
        output,
    ).run(schema, async (draft) => summaryFor(draft));

    assert.deepEqual(result?.draft.container, {
        containerName: "devshell-podman-one",
        image: "debian:stable",
        mode: "preset",
        preset: "debian",
    });
});

function createWizard(
    lines: string[],
    output: ReturnType<typeof createBuffer>,
): CliWizardInstanceCreate {
    return new CliWizardInstanceCreate({
        input: Readable.from(lines.map((line) => `${line}\n`)),
        output,
    });
}

function summaryFor(draft: InstanceCreateDraft): InstanceCreateSummary {
    const instance = normalizeConfigInstanceDraft(draft);
    return {
        ...(instance.container === undefined
            ? {}
            : { container: instance.container }),
        extensions: { model: [...instance.extensions.model] },
        enabled: instance.enabled,
        mcp: {
            auth: { mode: instance.mcp.auth.mode },
            contextMode: instance.mcp.contextMode,
            enabled: instance.mcp.enabled,
            path: instance.mcp.path,
        },
        name: instance.name,
        provider: instance.provider,
        security: { mode: instance.security.mode },
        ...(instance.ssh === undefined ? {} : { ssh: instance.ssh }),
    };
}

function createBuffer(): { flush(): string; write(chunk: string): void } {
    const chunks: string[] = [];
    return {
        flush() {
            const output = chunks.join("");
            chunks.length = 0;
            return output;
        },
        write(chunk: string) {
            chunks.push(chunk);
        },
    };
}
