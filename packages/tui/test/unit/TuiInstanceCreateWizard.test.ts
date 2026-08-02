import assert from "node:assert/strict";
import test from "node:test";

import type { InstanceCreateSchema, InstanceCreateSummary, JsonValue } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import { createDefaultInstanceDraft } from "../../src/state/editor/TuiEditorInstanceCreateDraft.ts";
import { buildInstancesPageBoxes } from "../../src/view/page/TuiPageInstances.ts";

const schema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"],
        presets: [{ image: "archlinux:latest", preset: "arch" }]
    },
    defaultEnabled: true,
    defaultMcpCapabilities: ["read", "write", "execute"],
    defaultMcpEnabled: true,
    defaultMcpGroups: ["bash", "file"],
    defaultProvider: "local",
    defaultSecurityMode: "disabled",
    providers: ["local", "ssh", "docker", "podman", "reverse"]
};

function wizard(step: number, patch: Record<string, JsonValue> = {}) {
    const store = new TuiAppStore();
    store.setSelectedPage("instances");
    store.setEditor({ editing: false, key: "create-instance", kind: "create", schema, step });
    store.setFormDraft("create-instance", deepMerge(createDefaultInstanceDraft(), patch), true);
    const box = buildInstancesPageBoxes(store.getState())[0];
    assert.ok(box);
    store.toggleExpanded(box.expandedKey);
    const expanded = buildInstancesPageBoxes(store.getState())[0];
    assert.ok(expanded?.expanded);
    return expanded.expandedLines
        .map((line) => line.id)
        .filter((id): id is string => id !== undefined);
}

function wizardText(
    step: number,
    patch: Record<string, JsonValue>,
    summary?: InstanceCreateSummary
): string {
    const store = new TuiAppStore();
    store.setSelectedPage("instances");
    store.setEditor({ editing: false, key: "create-instance", kind: "create", schema, step, summary });
    store.setFormDraft("create-instance", deepMerge(createDefaultInstanceDraft(), patch), true);
    const box = buildInstancesPageBoxes(store.getState())[0];
    assert.ok(box);
    store.toggleExpanded(box.expandedKey);
    const expanded = buildInstancesPageBoxes(store.getState())[0];
    assert.ok(expanded?.expanded);
    return expanded.expandedLines.map((line) => line.text).join("\n");
}

test("create provider step exposes only fields relevant to the selected provider and mode", () => {
    assert.equal(wizard(2, { provider: "local" }).some((id) => id.includes(":field:ssh.command")), false);
    assert.equal(wizard(2, { provider: "local" }).some((id) => id.includes(":field:container.mode")), false);

    const ssh = wizard(2, { provider: "ssh", ssh: { command: "ssh host" } });
    assert.equal(ssh.some((id) => id.includes(":field:ssh.command")), true);
    assert.equal(ssh.some((id) => id.includes(":field:container.mode")), false);

    const compose = wizard(2, {
        container: { compose: { file: "compose.yml", service: "dev" }, mode: "compose" },
        provider: "docker"
    });
    assert.equal(compose.some((id) => id.includes(":field:container.mode")), true);
    assert.equal(compose.some((id) => id.includes(":field:container.compose.file")), true);
    assert.equal(compose.some((id) => id.includes(":field:container.build.context")), false);
    assert.equal(compose.some((id) => id.includes(":field:podmanBinary")), false);
});

test("create wizard exposes complete MCP authentication, approval, logs, environment, and scheduler inputs", () => {
    const token = wizard(3, { mcp: { auth: "token", enabled: true, token: "secret", tools: { capabilities: ["read"], groups: ["file"] } } });
    assert.equal(token.some((id) => id.includes(":field:mcp.token")), true);

    const oauth = wizard(3, { mcp: { auth: "oauth2", enabled: true, oauth2: { requiredScopes: ["mcp"], resourceName: "instance" }, tools: { capabilities: ["read"], groups: ["file"] } } });
    assert.equal(oauth.some((id) => id.includes(":field:mcp.oauth2.resourceName")), true);
    assert.equal(oauth.some((id) => id.includes(":field:mcp.oauth2.requiredScopes")), true);

    const security = wizard(4);
    assert.equal(security.some((id) => id.includes(":field:approvalPolicy.mode")), true);
    assert.equal(security.some((id) => id.includes(":field:approvalPolicy.rules")), true);

    const runtime = wizard(5);
    for (const field of [
        "env",
        "logs.retentionDays",
        "logs.maxBytes",
        "logs.eventBufferSize",
        "tools.scheduler.maxRunning",
        "tools.scheduler.queueDepth",
        "tools.scheduler.queueTimeoutMs",
        "tools.scheduler.byTool"
    ]) {
        assert.equal(runtime.some((id) => id.includes(`:field:${field}`)), true, field);
    }
});

test("create wizard renders object arrays as editable JSON", () => {
    const provider = wizardText(2, {
        container: {
            containerName: "devshell-demo-docker",
            image: "archlinux:latest",
            mode: "existingImage",
            mounts: [{ source: "/host", target: "/container" }]
        },
        name: "demo-docker",
        provider: "docker"
    });
    const approval = wizardText(4, {
        approvalPolicy: {
            mode: "ask",
            rules: [{ decision: "ask", match: "exact", source: "mcp", toolName: "bash_run" }]
        }
    });

    assert.equal(provider.includes('[{"source":"/host","target":"/container"}]'), true);
    assert.equal(approval.includes('[{"decision":"ask","match":"exact","source":"mcp","toolName":"bash_run"}]'), true);
    assert.equal(provider.includes("[object Object]"), false);
    assert.equal(approval.includes("[object Object]"), false);
});

test("create wizard review and validation output redact every secret value", () => {
    const text = wizardText(
        6,
        {
            container: {
                containerName: "devshell-demo-docker",
                env: { CONTAINER_TOKEN: "container-secret" },
                image: "archlinux:latest",
                mode: "existingImage"
            },
            env: { API_TOKEN: "instance-secret" },
            mcp: {
                auth: "token",
                enabled: true,
                token: "mcp-secret",
                tools: { capabilities: ["read"], groups: ["file"] }
            },
            name: "demo-docker",
            provider: "docker"
        },
        {
            enabled: true,
            env: { API_TOKEN: "summary-secret" },
            mcp: {
                auth: { mode: "none" },
                enabled: true,
                path: "/demo-docker/mcp",
                tools: { capabilities: ["read"], groups: ["file"] }
            },
            name: "demo-docker",
            provider: "docker",
            security: { mode: "disabled" }
        }
    );

    for (const secret of ["container-secret", "instance-secret", "mcp-secret", "summary-secret"]) {
        assert.equal(text.includes(secret), false, secret);
    }
    assert.equal(text.includes("********"), true);
});

function deepMerge(base: Record<string, JsonValue>, patch: Record<string, JsonValue>): Record<string, JsonValue> {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(patch)) {
        const current = result[key];
        result[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
    }
    return result;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
