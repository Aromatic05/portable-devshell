import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type {
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary
} from "@portable-devshell/shared";

import { CliWizardInstanceCreate } from "../../dist/wizard/CliWizardInstanceCreate.js";

const schema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: [
            "preset",
            "dockerfile",
            "compose",
            "existingImage",
            "existingStoppedContainer"
        ],
        presets: [
            { image: "archlinux:latest", preset: "arch" },
            { image: "debian:stable", preset: "debian" }
        ]
    },
    defaultEnabled: true,
    defaultMcpCapabilities: ["read", "write", "execute"],
    defaultMcpEnabled: true,
    defaultMcpGroups: ["file", "bash", "artifact"],
    defaultProvider: "local",
    defaultSecurityMode: "disabled",
    providers: ["local", "ssh", "docker", "podman", "reverse"]
};

test("instance wizard retries invalid basic answers, deduplicates lists, and supports cancellation", async () => {
    const output = createBuffer();
    let validated: InstanceCreateDraft | undefined;
    const wizard = createWizard(
        [
            "",
            "demo-local",
            "maybe",
            "",
            "cloud",
            "",
            "",
            "",
            "file,file bash",
            "read execute read",
            "unsafe",
            "workspace",
            "n"
        ],
        output
    );

    const result = await wizard.run(schema, async (draft) => {
        validated = draft;
        return summaryFor(draft);
    });

    assert.equal(result, undefined);
    assert.equal(validated?.name, "demo-local");
    assert.equal(validated?.provider, "local");
    assert.equal(validated?.security?.mode, "workspace");
    assert.deepEqual(validated?.mcp?.tools?.groups, ["file", "bash"]);
    assert.deepEqual(validated?.mcp?.tools?.capabilities, ["read", "execute"]);

    const text = output.flush();
    assert.match(text, /instance name is required/u);
    assert.match(text, /Please answer yes or no/u);
    assert.match(text, /provider must be one of local, ssh, docker, podman, reverse/u);
    assert.match(text, /security mode must be disabled or workspace/u);
    assert.match(text, /Instance creation cancelled/u);
});

test("instance wizard collects SSH configuration and accepts validated creation", async () => {
    const output = createBuffer();
    const wizard = createWizard(
        [
            "remote-one",
            "",
            "ssh",
            "/remote/work",
            "",
            "ssh devbox",
            "n",
            "",
            "",
            "",
            "y"
        ],
        output
    );

    const result = await wizard.run(schema, async (draft) => summaryFor(draft));

    assert.notEqual(result, undefined);
    assert.deepEqual(result?.draft, {
        enabled: true,
        mcp: {
            enabled: false,
            tools: {
                capabilities: ["read", "write", "execute"],
                groups: ["file", "bash", "artifact"]
            }
        },
        name: "remote-one",
        provider: "ssh",
        security: { mode: "disabled" },
        ssh: { command: "ssh devbox" },
        workspace: "/remote/work"
    });

    const text = output.flush();
    assert.match(text, /ssh command is required/u);
    assert.match(text, /Summary/u);
    assert.match(text, /ssh command: ssh devbox/u);
    assert.match(text, /mcp enabled: false/u);
});

test("instance wizard validates and collects a managed Docker preset", async () => {
    const output = createBuffer();
    const wizard = createWizard(
        [
            "docker-one",
            "",
            "docker",
            "/workspace",
            "9",
            "1",
            "unknown",
            "debian",
            "",
            "1000",
            "bridge",
            "y",
            "/host",
            "/container",
            "invalid",
            "ro",
            "n",
            "y",
            "TOKEN",
            "secret",
            "n",
            "",
            "/usr/bin/docker",
            "",
            "",
            "",
            "",
            "y"
        ],
        output
    );

    const result = await wizard.run(schema, async (draft) => summaryFor(draft));

    assert.notEqual(result, undefined);
    assert.deepEqual(result?.draft.container, {
        containerName: "devshell-docker-one",
        env: { TOKEN: "secret" },
        image: "debian:stable",
        mode: "preset",
        mounts: [
            {
                mode: "ro",
                source: "/host",
                target: "/container"
            }
        ],
        network: "bridge",
        preset: "debian",
        user: "1000"
    });
    assert.equal(result?.draft.dockerBinary, "/usr/bin/docker");

    const text = output.flush();
    assert.match(text, /selection must be 1-5/u);
    assert.match(text, /preset must match one of the listed presets/u);
    assert.match(text, /mount mode must be ro or rw/u);
    assert.match(text, /container image: debian:stable/u);
    assert.match(text, /docker binary: \/usr\/bin\/docker/u);
});

function createWizard(lines: string[], output: ReturnType<typeof createBuffer>): CliWizardInstanceCreate {
    return new CliWizardInstanceCreate({
        input: Readable.from(lines.map((line) => `${line}\n`)),
        output
    });
}

function summaryFor(draft: InstanceCreateDraft): InstanceCreateSummary {
    return {
        ...(draft.container === undefined ? {} : { container: draft.container }),
        ...(draft.dockerBinary === undefined ? {} : { dockerBinary: draft.dockerBinary }),
        ...(draft.podmanBinary === undefined ? {} : { podmanBinary: draft.podmanBinary }),
        ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
        enabled: draft.enabled ?? true,
        mcp: {
            enabled: draft.mcp?.enabled ?? true,
            path: `/${draft.name}/mcp`,
            tools: {
                capabilities: [...(draft.mcp?.tools?.capabilities ?? [])],
                groups: [...(draft.mcp?.tools?.groups ?? [])]
            }
        },
        name: draft.name,
        provider: draft.provider,
        security: {
            mode: draft.security?.mode ?? "disabled"
        },
        workspace: draft.workspace
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
        }
    };
}
