import assert from "node:assert/strict";
import test from "node:test";

import {
    ApprovalManager,
    ApprovalStore,
} from "@portable-devshell/core/testing";
import { asInstanceName, type ApprovalRequest } from "@portable-devshell/shared";

import { ToolCallApproval } from "../../../../src/toolcall/Approval.ts";

function approval(mode: "allow" | "deny") {
    const records: ApprovalRequest[] = [];
    const manager = new ApprovalManager({
        instanceName: asInstanceName("approval-review"),
        policy: { mode },
        store: new ApprovalStore({
            async append(request: ApprovalRequest) {
                records.push(structuredClone(request));
            },
            async readAll() {
                return records.map((request) => structuredClone(request));
            },
        }),
        timeout: { ms: 60_000 },
    });
    return new ToolCallApproval({
        approvalManager: manager,
        async appendEvent() {},
    });
}

const input = {
    callId: "call-approval",
    direction: "inbound" as const,
    value: {
        context: {
            ctxId: "ctx-approval",
            instance: asInstanceName("approval-review"),
            source: "mcp" as const,
        },
        kind: "call" as const,
        payload: { command: "echo ok" },
        toolName: "bash_run",
    },
};

test("ToolCallApproval is an inbound call review", async () => {
    const allow = approval("allow");
    const signal = new AbortController().signal;

    assert.deepEqual(await allow.review(input, signal, "host"), {
        decision: "continue",
    });
    assert.deepEqual(
        await allow.review(
            {
                ...input,
                direction: "outbound",
                value: { ...input.value, kind: "result" },
            },
            signal,
            "host",
        ),
        { decision: "continue" },
    );
});

test("ToolCallApproval maps policy denial to review rejection", async () => {
    const deny = approval("deny");
    const result = await deny.review(
        input,
        new AbortController().signal,
        "host",
    );

    assert.equal(result.decision, "reject");
    assert.equal(result.error?.code, "core.approvalDenied");
});
