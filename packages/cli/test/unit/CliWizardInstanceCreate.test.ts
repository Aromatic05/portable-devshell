import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import type {
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary
} from "@portable-devshell/shared";

import { CliWizardInstanceCreate } from "../../src/wizard/CliWizardInstanceCreate.ts";

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
    defaultMcpContextMode: "explicit",
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
            "",
            "file,file bash",
            "read execute read",
            "unsafe",
            "workspace",
            "",
            "",
            "",
            "",
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
    assert.equal(validated?.mcp?.contextMode, "explicit");
    assert.deepEqual(validated?.mcp?.tools?.groups, ["file", "bash"]);
    assert.deepEqual(validated?.mcp?.tools?.capabilities, ["read", "execute"]);
});

test("instance wizard collects SSH configuration and accepts validated creation", async () => {
    const output = createBuffer();
    const wizard = createWizard(
        [
            "remote-one",
            "",
            "ssh",
            "ssh devbox",
            "n",
            "",
            "",
            "",
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
    assert.deepEqual(result?.draft, {
        enabled: true,
        mcp: {
            auth: "none",
            contextMode: "explicit",
            enabled: false,
            tools: {
                capabilities: ["read", "write", "execute"],
                groups: ["file", "bash", "artifact"]
            }
        },
        name: "remote-one",
        provider: "ssh",
        security: { mode: "disabled" },
        ssh: { command: "ssh devbox" }
    });
});

test("instance wizard collects complete OAuth, approval, environment, log, and scheduler configuration", async () => {
    const output = createBuffer();
    const wizard = createWizard(
        [
            "complete-local",
            "",
            "local",
            "",
            "oauth2",
            "complete-resource",
            "mcp profile",
            "https://docs.example.test/mcp",
            "openai-session",
            "file bash",
            "read write execute",
            "workspace",
            "ask",
            '[{"decision":"allow","match":"exact","source":"cli","toolName":"file_read"}]',
            "y",
            "API_TOKEN",
            "instance-secret",
            "n",
            "y",
            "14",
            "1048576",
            "512",
            "y",
            "4",
            "2",
            "32",
            "8",
            "30000",
            '{"bash_run":{"maxRunning":1,"queueDepth":4}}',
            "y"
        ],
        output
    );

    const result = await wizard.run(schema, async (draft) => summaryFor(draft));

    assert.notEqual(result, undefined);
    assert.deepEqual(result?.draft.mcp, {
        auth: "oauth2",
        contextMode: "openai-session",
        enabled: true,
        oauth2: {
            documentationUrl: "https://docs.example.test/mcp",
            requiredScopes: ["mcp", "profile"],
            resourceName: "complete-resource"
        },
        tools: {
            capabilities: ["read", "write", "execute"],
            groups: ["file", "bash"]
        }
    });
    assert.deepEqual(result?.draft.approvalPolicy, {
        mode: "ask",
        rules: [{ decision: "allow", match: "exact", source: "cli", toolName: "file_read" }]
    });
    assert.deepEqual(result?.draft.env, { API_TOKEN: "instance-secret" });
    assert.deepEqual(result?.draft.logs, {
        eventBufferSize: 512,
        maxBytes: 1048576,
        retentionDays: 14
    });
    assert.deepEqual(result?.draft.tools, {
        scheduler: {
            byTool: { bash_run: { maxRunning: 1, queueDepth: 4 } },
            maxRunning: 4,
            maxRunningPerSession: 2,
            queueDepth: 32,
            queueDepthPerSession: 8,
            queueTimeoutMs: 30000
        }
    });

    const text = output.flush();
    assert.doesNotMatch(text, /instance-secret/u);
});

test("instance wizard validates and collects a managed Docker preset", async () => {
    const output = createBuffer();
    const wizard = createWizard(
        [
            "docker-one",
            "",
            "docker",
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
            "",
            "",
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
});

function createWizard(lines: string[], output: ReturnType<typeof createBuffer>): CliWizardInstanceCreate {
    return new CliWizardInstanceCreate({
        input: Readable.from(lines.map((line) => `${line}\n`)),
        output
    });
}

function summaryFor(draft: InstanceCreateDraft): InstanceCreateSummary {
    const instance = normalizeConfigInstanceDraft(draft);
    return {
        ...(instance.approvalPolicy === undefined ? {} : { approvalPolicy: structuredClone(instance.approvalPolicy) }),
        ...(instance.container === undefined ? {} : { container: instance.container }),
        ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
        ...(instance.env === undefined ? {} : { env: { ...instance.env } }),
        ...(instance.logs === undefined ? {} : { logs: { ...instance.logs } }),
        ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
        ...(instance.ssh === undefined ? {} : { ssh: instance.ssh }),
        ...(instance.tools === undefined ? {} : { tools: structuredClone(instance.tools) }),
        enabled: instance.enabled,
        mcp: {
            auth: {
                mode: instance.mcp.auth.mode,
                ...(instance.mcp.auth.mode === "oauth2"
                    ? { oauth2: structuredClone(instance.mcp.auth.oauth2) }
                    : {})
            },
            contextMode: instance.mcp.contextMode,
            enabled: instance.mcp.enabled,
            path: instance.mcp.path,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        name: instance.name,
        provider: instance.provider,
        security: {
            mode: instance.security.mode
        }
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
