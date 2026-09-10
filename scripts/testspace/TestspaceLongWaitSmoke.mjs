import { randomUUID } from "node:crypto";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const TESTSPACE_LONG_WAIT_TASK_DURATION_MS = 190_000;
export const TESTSPACE_LONG_WAIT_TOOL_TIMEOUT_MS = 220_000;
export const TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS = 240_000;
const MINIMUM_EXPECTED_DETACH_MS = 170_000;
const FINAL_READ_TIMEOUT_MS = 45_000;

export async function runTestspaceLongWaitSmoke({ endpoint, workspace }) {
    if (process.platform === "win32") {
        throw new Error("Testspace long tmux wait smoke is not supported on Windows.");
    }

    const client = new Client({
        name: "portable-devshell-testspace-long-wait-smoke",
        version: "0.0.0",
    });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        assertToolSuccess(environment, "long wait environ_info");
        const ctxId = environment.structuredContent?.ctxId;
        if (typeof ctxId !== "string" || ctxId.length === 0) {
            throw new Error("long wait environ_info did not return a ctxId");
        }

        const marker = `testspace-long-wait-${randomUUID()}`;
        const startedAt = Date.now();
        const launched = await client.callTool({
            arguments: {
                command: `sleep ${TESTSPACE_LONG_WAIT_TASK_DURATION_MS / 1000}; printf '%s\\n' '${marker}'`,
                ctxId,
                line: 20,
                timeout: TESTSPACE_LONG_WAIT_TOOL_TIMEOUT_MS,
                wait: "block",
            },
            name: "tmux_run",
        }, {
            maxTotalTimeout: TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS,
            timeout: TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS,
        });
        const detachedAfterMs = Date.now() - startedAt;
        assertToolSuccess(launched, "long wait tmux_run");
        const launch = launched.structuredContent;
        const taskId = readTaskId(launch);
        if (launch?.detached !== true || readTaskStatus(launch) !== "running") {
            throw new Error(`long wait tmux_run did not hand off a running task: ${JSON.stringify(launch)}`);
        }
        if (detachedAfterMs < MINIMUM_EXPECTED_DETACH_MS || detachedAfterMs >= TESTSPACE_LONG_WAIT_TASK_DURATION_MS) {
            throw new Error(
                `long wait tmux_run detached outside the expected 180s boundary: ${detachedAfterMs}ms`,
            );
        }

        const readStartedAt = Date.now();
        const completed = await client.callTool({
            arguments: {
                ctxId,
                line: -20,
                task: taskId,
                timeMs: FINAL_READ_TIMEOUT_MS,
            },
            name: "tmux_read",
        }, {
            maxTotalTimeout: FINAL_READ_TIMEOUT_MS + 15_000,
            timeout: FINAL_READ_TIMEOUT_MS + 15_000,
        });
        const finalReadMs = Date.now() - readStartedAt;
        assertToolSuccess(completed, "long wait tmux_read");
        const completion = completed.structuredContent;
        if (readTaskStatus(completion) !== "0") {
            throw new Error(`long wait tmux_read did not return a successful task: ${JSON.stringify(completion)}`);
        }
        const output = Array.isArray(completion?.output) ? completion.output.map(String) : [];
        if (!output.some((line) => line.includes(marker))) {
            throw new Error(`long wait tmux_read missed the completion marker: ${JSON.stringify(completion)}`);
        }

        return {
            detached: true,
            detachedAfterMs,
            finalReadMs,
            task: { id: taskId, status: readTaskStatus(completion) },
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}

function assertToolSuccess(result, label) {
    if (result.isError === true) {
        throw new Error(`${label} failed: ${JSON.stringify(result)}`);
    }
}

function readTaskId(value) {
    const id = value?.task?.id;
    if (typeof id !== "string" || id.length === 0) {
        throw new Error(`long wait result is missing a task id: ${JSON.stringify(value)}`);
    }
    return id;
}

function readTaskStatus(value) {
    const status = value?.task?.status;
    return typeof status === "string" ? status : undefined;
}
