import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** Real MCP clients exercise the model CLI broker and Worker-owned file transport. */
export async function runTestspaceMailingSmoke({ endpoint, workspace }) {
    const clients = ["a", "b"].map((tag) => new Client({
        name: "testspace-mailing-" + tag,
        version: "0.0.0",
    }, { versionNegotiation: { mode: "auto" } }));
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const first = "mailing-smoke-a-" + suffix;
    const second = "mailing-smoke-b-" + suffix;
    const subject = "Mailing integration " + suffix;
    const body = "File-backed Worker message body " + suffix;
    try {
        for (const client of clients)
            await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const [a, b] = clients;
        const initialA = await context(a, workspace);
        const initialB = await context(b, workspace);
        const ctxA = initialA.ctxId;
        const ctxB = initialB.ctxId;
        assert.notEqual(ctxA, ctxB, "Independent agents need independent Contexts");
        assert.notEqual(initialA.temporaryDirectory, initialB.temporaryDirectory,
            "Independent Contexts must not share temporary directories");

        const claimedA = await bash(a, ctxA, "devshell memory init " + first);
        const claimedB = await bash(b, ctxB, "devshell memory init " + second);
        assertExit(claimedA, 0, "memory init A");
        assertExit(claimedB, 0, "memory init B");
        assert.match(claimedA.stdout, new RegExp(first, "u"));
        assert.match(claimedB.stdout, new RegExp(second, "u"));

        const initialized = await context(a, workspace, ctxA);
        assert.equal(initialized.temporaryDirectory, initialA.temporaryDirectory,
            "environ_info must reuse the Context temporary directory");
        assert.equal(initialized.memory?.name, first);
        assert.equal(initialized.memory?.directory, workspace + "/var/agent-work/" + first);
        assert.equal(initialized.projectMemoryDirectory, initialized.memory.directory);
        assert.equal(initialized.projectMemoryAgentFile, initialized.memory.directory + "/INDEX.md");
        const repeated = await context(a, workspace, ctxA);
        assert.equal(repeated.temporaryDirectory, initialA.temporaryDirectory);
        assert.deepEqual(repeated.memory, initialized.memory);

        const outbox = "var/agent-work/" + first + "/chat.md";
        const inbox = "var/agent-work/" + second + "/mailbox.md";
        const changes = [
            "*** Begin Edit",
            "*** Write File: " + outbox,
            "<!-- MAIL BEGIN -->",
            "To: " + second,
            "Subject: " + subject,
            "",
            body,
            "<!-- MAIL END -->",
            "*** End Edit",
        ].join("\n");
        const written = await a.callTool({ name: "file_edit", arguments: {
            ctxId: ctxA, changes, resultDetail: "summary",
        } });
        assert.equal(written.isError, false, "file_edit failed: " + JSON.stringify(written));
        const operations = written.structuredContent?.operations;
        assert.ok(Array.isArray(operations) && operations[0]?.status === "applied");

        let delivered = "";
        let notified = false;
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
            const response = await b.callTool({ name: "file_read", arguments: {
                ctxId: ctxB, files: [{ path: inbox, view: "content" }],
            } });
            const file = response.structuredContent?.files?.[0];
            if (typeof file?.content === "string" && file.content.includes(body))
                delivered = file.content;
            if (Array.isArray(response.structuredContent?.comment) &&
                response.structuredContent.comment.some((message) => String(message).includes(subject)))
                notified = true;
            if (delivered && notified) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.ok(delivered.includes(subject) && delivered.includes(body),
            "The mailbox did not receive the full message");
        assert.equal(notified, true, "Comment did not deliver the mail Subject");

        const index = await a.callTool({ name: "file_read", arguments: {
            ctxId: ctxA, files: [{ path: "var/agent-work/mailing.md", view: "content" }],
        } });
        assert.ok(String(index.structuredContent?.files?.[0]?.content).includes(subject),
            "Mailing global index was not populated");

        const status = await bash(b, ctxB, "devshell memory");
        assertExit(status, 0, "status");
        assert.match(status.stdout, new RegExp(second, "u"));

        const inherited = await bash(b, ctxB, "devshell memory inherit " + first);
        assertExit(inherited, 0, "memory inherit");
        const resumed = await context(b, workspace, ctxB);
        assert.equal(resumed.temporaryDirectory, initialB.temporaryDirectory);
        assert.equal(resumed.memory?.directory, initialized.memory.directory);
        assert.equal(resumed.projectMemoryDirectory, initialized.memory.directory);
        const previous = await bash(a, ctxA, "devshell memory");
        assertExit(previous, 0, "prior owner memory");
        assert.ok(!previous.stdout.includes(first), "The prior Context must lose ownership");
        const formerOwner = await context(a, workspace, ctxA);
        assert.equal(formerOwner.temporaryDirectory, initialA.temporaryDirectory);
        assert.equal(formerOwner.memory, undefined,
            "environ_info must not show a Memory after another Context inherits it");
        const recovered = await bash(b, ctxB, "devshell memory");
        assert.match(recovered.stdout, new RegExp(first, "u"));

        const released = await bash(b, ctxB, "devshell memory release");
        assertExit(released, 0, "release");
        assert.equal((await context(b, workspace, ctxB)).memory, undefined);

        const names = (await a.listTools()).tools.map((tool) => tool.name);
        assert.equal(names.some((name) => name.startsWith("mail_")), false,
            "Mailing must not add MCP tools");

        return { first, second, subject, delivered: true, notified: true,
            memoryTransferVerified: true, noNewMcpTool: true };
    } finally {
        await Promise.allSettled(clients.map(async (client) => client.close()));
    }
}

async function context(client, workspace, ctxId) {
    const result = await client.callTool({ name: "environ_info", arguments: {
        workspace, ...(ctxId === undefined ? {} : { ctxId }),
    } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(typeof result.structuredContent?.ctxId === "string" &&
        result.structuredContent.ctxId.length > 0);
    return result.structuredContent;
}

async function bash(client, ctxId, command) {
    const result = await client.callTool({ name: "bash_run", arguments: {
        ctxId, command, timeoutMs: 30_000,
    } });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
}

function assertExit(result, expected, operation) {
    assert.equal(result?.exitCode, expected, operation + ": " + JSON.stringify(result));
}
