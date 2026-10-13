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
        const widgetFor = (name) => toolCallResource.uri + "?widgetRevision=1&toolName=" + name;
        assert.equal(template("environ_info"), widgetFor("environ_info"));
        assert.equal(template("mcpapp_open"), workspaceResource.uri);
        assert.equal(template("mcpapp_ask"), inlineResource.uri);
        assert.equal(template("bash_run"), widgetFor("bash_run"));
        assert.notEqual(template("bash_run"), template("file_read"));
        for (const name of ["bash_run", "file_read", "file_glob", "file_edit", "todo_report"]) {
            assert.equal(template(name), widgetFor(name));
            const variant = await client.readResource({ uri: widgetFor(name) });
            assert.match(variant.contents[0]?.text ?? "", new RegExp('data-tool-name="' + name + '"', "u"));
            assert.equal(variant.contents[0]?.uri, widgetFor(name));
        }

        // Ordinary ToolCalls are static Widgets with no Live Lease. The
        // explicit Workspace still shows their audited target and status.
        const command = "printf 'mcpapp-smoke-ok\\n'";
        const shell = await client.callTool({ name: "bash_run", arguments: {
            ctxId, command, cwd: "./", timeoutMs: 10_000,
            purpose: "Verify ToolCall history in Workspace",
        } });
        assert.equal(shell.isError, false);
        assert.equal(shell.structuredContent?.exitCode, 0);
        assert.equal(shell._meta?.["portable-devshell/toolcall"]?.name, "bash_run");
        assert.equal(shell._meta?.["portable-devshell/mcpapp"], undefined);
        assert.equal(shell._meta?.["openai/outputTemplate"], template("bash_run"));
        const shellWidget = shell._meta?.["portable-devshell/widgetPayload"];
        assert.equal(shellWidget?.schema, "portable-devshell.toolcall.v1");
        assert.equal(shellWidget?.toolName, "bash_run");
        assert.match(shellWidget?.output?.stdout ?? "", /mcpapp-smoke-ok/u);
        assert.match(shellWidget?.input?.command ?? "", /mcpapp-smoke-ok/u);
        assert.equal(JSON.stringify(shellWidget).includes(token), false);
        const audited = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(audited.status, 200);
        const history = (await audited.json()).activity;
        const shellCard = history?.find((item) => item.name === "bash_run" && item.target?.includes("mcpapp-smoke-ok"));
        assert.ok(shellCard, "Completed tool does not appear in the Workspace audit history.");
        assert.equal(shellCard.state, "completed");
        assert.match(shellCard.summary, /exit 0/u);
        // Core deliberately stores byte counts but omits command streams in
        // durable ToolCall audit. The Inline result itself still has stdout.
        assert.match(shell.structuredContent?.stdout ?? "", /mcpapp-smoke-ok/u);
        assert.match(shellCard.summary, /stdout bytes/u);
        assert.equal(shellCard.output?.stdout, undefined);
        assert.match(shellCard.input?.command ?? "", /mcpapp-smoke-ok/u);

        // Real tool outputs must reach the Workspace as typed presentation
        // data. These operations touch only the disposable testspace workspace.
        const sample = "./mcpapp-semantic-smoke.txt";
        const prepare = await client.callTool({ name: "bash_run", arguments: {
            ctxId, cwd: "./", command: "printf 'widget-marker\\n' > ./mcpapp-semantic-smoke.txt",
            timeoutMs: 10_000, purpose: "Prepare isolated renderer sample",
        } });
        assert.equal(prepare.isError, false);
        assert.equal(prepare.structuredContent?.exitCode, 0);
        const found = await client.callTool({ name: "file_glob", arguments: {
            ctxId, patterns: [sample],
        } });
        assert.equal(found.isError, false);
        assert.equal(found.structuredContent?.entries?.[0]?.path, sample);
        const read = await client.callTool({ name: "file_read", arguments: {
            ctxId, files: [{ path: sample }],
        } });
        assert.equal(read.isError, false);
        assert.match(read.structuredContent?.files?.[0]?.content ?? "", /1:widget-marker/u);
        assert.equal(read._meta?.["openai/outputTemplate"], template("file_read"));
        assert.match(read._meta?.["portable-devshell/widgetPayload"]?.output?.files?.[0]?.content ?? "",
            /1:widget-marker/u);
        const searched = await client.callTool({ name: "file_grep", arguments: {
            ctxId, paths: [sample], pattern: "widget-marker", syntax: "literal",
        } });
        assert.equal(searched.isError, false);
        assert.match(searched.structuredContent?.files?.[0]?.content ?? "", /widget-marker/u);
        const edit = await client.callTool({ name: "file_edit", arguments: {
            ctxId,
            changes: "*** Begin Edit\n*** Patch File: ./mcpapp-semantic-smoke.txt\n@@\n-widget-marker\n+widget-marker-edited\n*** End Edit",
            resultDetail: "diff",
        } });
        assert.equal(edit.isError, false);
        assert.equal(edit.structuredContent?.operations?.[0]?.status, "applied");
        assert.equal(typeof edit.structuredContent?.operations?.[0]?.diff, "string");
        const presentation = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(presentation.status, 200);
        const displayed = (await presentation.json()).activity;
        for (const name of ["file_glob", "file_read", "file_grep", "file_edit"]) {
            assert.ok(displayed?.some((item) => item.name === name && item.output),
                `${name} was not projected as typed Workspace history`);
        }
        const diffCard = displayed.find((item) => item.name === "file_edit");
        assert.equal(diffCard.output?.operations?.[0]?.status, "applied");
        assert.equal(typeof diffCard.output?.operations?.[0]?.diff, "string");

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
            fullscreenAdvertised: true, auditedToolCall: true, semanticToolsAudited: true,
            selfContainedToolWidgets: true,
            inlineAskAnswered: true,
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}
