import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export async function runTestspaceWorkspaceSmoke({
    endpoint,
    instance,
    workspace,
}) {
    const client = new Client({
        name: "testspace-workspace-smoke",
        version: "0.0.0",
    }, { versionNegotiation: { mode: "auto" } });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL(endpoint)),
        );

        const listed = await client.listResources();
        const workspaceResource = listed.resources.find(
            (resource) =>
                resource.name === "portable-devshell MCP App" &&
                resource.uri.startsWith("ui://portable-devshell/mcpapp-"),
        );
        assert.notEqual(
            workspaceResource,
            undefined,
            "MCP App resource is not discoverable from the Testspace endpoint.",
        );
        const resource = await client.readResource({
            uri: workspaceResource.uri,
        });
        const html = resource.contents
            .map((content) =>
                typeof content.text === "string" ? content.text : "",
            )
            .join("\n");
        assert.match(html, /DevShell Workspace/u);
        assert.match(html, /id="root"/u);

        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        assert.equal(typeof ctxId, "string");
        assert.notEqual(ctxId, "");
        const meta = environment._meta?.["portable-devshell/mcpapp"];
        assert.equal(typeof meta, "object");
        assert.notEqual(meta, null);
        const token = meta?.token;
        const liveBaseUrl = meta?.liveBaseUrl;
        assert.equal(typeof token, "string");
        assert.notEqual(token, "");
        assert.equal(typeof liveBaseUrl, "string");
        assert.notEqual(liveBaseUrl, "");

        const snapshotUrl = new URL(`${liveBaseUrl}/snapshot`);
        snapshotUrl.searchParams.set("ctxId", ctxId);
        assert.equal((await fetch(snapshotUrl)).status, 401);
        const snapshotResponse = await fetch(snapshotUrl, {
            headers: { authorization: `Bearer ${token}` },
        });
        const snapshotText = await snapshotResponse.text();
        assert.equal(snapshotResponse.status, 200, snapshotText);
        const snapshot = JSON.parse(snapshotText);
        assert.equal(snapshot.ctxId, ctxId);
        assert.equal(snapshot.instance, instance);
        assert.equal(Number.isSafeInteger(snapshot.cursor), true);
        assert.equal(Array.isArray(snapshot.presentation?.work), true);
        assert.equal(Array.isArray(snapshot.presentation?.background), true);
        assert.equal(typeof snapshot.modelContext?.structuredContent, "object");
        assert.equal(typeof snapshot.reentry?.pending, "boolean");

        // Workspace, interaction, and ToolCall are distinct MCP App resources.
        const inlineResource = listed.resources.find((item) =>
            item.name === "portable-devshell MCP App Interaction");
        const toolCallResource = listed.resources.find((item) =>
            item.name === "portable-devshell ToolCall Inline");
        assert.ok(inlineResource, "Inline interaction resource is missing.");
        assert.ok(toolCallResource, "Inline ToolCall resource is missing.");
        const inline = await client.readResource({ uri: inlineResource.uri });
        const toolCallView = await client.readResource({ uri: toolCallResource.uri });
        assert.deepEqual(inline.contents[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["inline"]);
        assert.deepEqual(resource.contents[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["fullscreen"]);
        assert.deepEqual(toolCallView.contents[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["inline"]);
        assert.match(inline.contents[0]?.text ?? "", /data-mcpapp-view="interaction"/u);
        assert.match(html, /data-mcpapp-view="workspace"/u);
        assert.match(toolCallView.contents[0]?.text ?? "", /data-mcpapp-view="toolcall"/u);
        const tools = (await client.listTools()).tools;
        const template = (name) => tools.find((tool) => tool.name === name)?._meta?.["openai/outputTemplate"];
        assert.equal(template("environ_info"), toolCallResource.uri);
        assert.equal(template("mcpapp_open"), workspaceResource.uri);
        assert.equal(template("mcpapp_ask"), inlineResource.uri);
        assert.equal(template("bash_run"), toolCallResource.uri);

        // Ordinary ToolCalls provide the live capability without executing
        // mcpapp_open again. The persistent Workspace shows their audit card
        // after completion, including target and status.
        const command = "printf 'mcpapp-smoke-ok\\n'";
        const shell = await client.callTool({ name: "bash_run", arguments: {
            ctxId, command, cwd: "./", timeoutMs: 10_000,
            purpose: "Verify ToolCall history in Workspace",
        } });
        assert.equal(shell.isError, false);
        assert.equal(shell.structuredContent?.exitCode, 0);
        assert.equal(shell._meta?.["portable-devshell/toolcall"]?.name, "bash_run");
        assert.equal(shell._meta?.["portable-devshell/mcpapp"]?.ctxId, ctxId);
        const audited = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(audited.status, 200);
        const history = (await audited.json()).activity;
        const shellCard = history?.find((item) => item.name === "bash_run" && item.target?.includes("mcpapp-smoke-ok"));
        assert.ok(shellCard, "Completed tool does not appear in the Workspace audit history.");
        assert.equal(shellCard.state, "completed");
        assert.match(shellCard.summary, /exit 0/u);

        // A new inline ask must be able to show a pending question before the
        // blocked tool finishes; answer it using the real MCP App action.
        const opened = await client.callTool({ name: "mcpapp_open", arguments: { ctxId } });
        assert.equal(opened.isError, false);
        assert.equal(opened.structuredContent?.status, "ready");
        assert.equal(opened._meta?.["portable-devshell/mcpapp"]?.ctxId, ctxId);
        const pendingAsk = client.callTool({
            name: "mcpapp_ask",
            arguments: { ctxId, question: "Testspace inline question?", choices: ["Yes", "No"], allowText: false },
        }, { timeout: 20_000, maxTotalTimeout: 20_000 });
        let question;
        for (let i = 0; i < 60; i++) {
            const response = await fetch(snapshotUrl, { headers: { authorization: "Bearer " + token } });
            assert.equal(response.status, 200);
            const current = await response.json();
            if (current.presentation?.primary?.title === "Question for you") {
                question = current.presentation.primary;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(question, "Question did not appear in the live inline snapshot.");
        assert.equal(question.detail, "Testspace inline question?");
        const answered = await client.callTool({ name: "mcpapp_action", arguments: {
            ctxId, itemId: question.id, actionId: "question-answer-choice",
            requestId: randomUUID(), input: "Yes",
        } });
        assert.equal(answered.isError, false);
        assert.equal(answered.structuredContent?.status, "applied");
        const completed = await pendingAsk;
        assert.equal(completed.isError, false);
        assert.deepEqual(completed.structuredContent, {
            status: "answered", questionId: question.id, answer: "Yes",
        });
        return {
            ctxId, cursor: snapshot.cursor, instance: snapshot.instance,
            resourceUri: workspaceResource.uri,
            interactionResourceUri: inlineResource.uri,
            toolCallResourceUri: toolCallResource.uri,
            fullscreenAdvertised: true, auditedToolCall: true, inlineAskAnswered: true,
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}
