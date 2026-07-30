import { describe, expect, it } from "vitest";
import { asInstanceName, type InstanceEvent } from "@portable-devshell/shared/browser";

import { formatEventPayload } from "../src/formatters/activity.js";
import { activityResult, filterActivity } from "../src/selectors/activity.js";

const events: InstanceEvent[] = [
    { at: "2026-07-31T08:30:00Z", instanceName: asInstanceName("alpha"), seq: 1, type: "toolCall.completed" },
    { at: "2026-07-31T09:30:00Z", instanceName: asInstanceName("alpha"), seq: 2, type: "toolCall.failed" },
    { at: "2026-07-31T09:45:00Z", instanceName: asInstanceName("beta"), seq: 3, type: "toolCall.pendingApproval" },
];

describe("activity read model", () => {
    it("applies text, instance, result, type, and time filters together", () => {
        expect(filterActivity(events, { instance: "alpha", period: "1h", query: "failed", result: "failure", type: "toolCall.failed" }, Date.parse("2026-07-31T10:00:00Z"))).toEqual([events[1]]);
        expect(filterActivity(events, { instance: "all", period: "24h", query: "", result: "pending", type: "all" }, Date.parse("2026-07-31T10:00:00Z"))).toEqual([events[2]]);
    });

    it("bounds payload detail and redacts raw tool input and credentials", () => {
        const payload = formatEventPayload({ cmd: "cat ~/.ssh/id_ed25519", input: "rm -rf /", nested: { token: "secret-token", safe: "visible" }, output: "private output", stderr: "private stderr", records: Array.from({ length: 30 }, (_, index) => index) });

        expect(payload).toContain("[redacted]");
        expect(payload).toContain("visible");
        expect(payload).not.toContain("rm -rf");
        expect(payload).not.toContain("secret-token");
        expect(payload).not.toContain("private output");
        expect(payload).not.toContain("private stderr");
        expect(payload).not.toContain("id_ed25519");
        expect(payload.length).toBeLessThanOrEqual(1201);
    });

    it("does not classify disconnected events as connected success", () => {
        expect(activityResult({ at: "2026-07-31T10:00:00Z", instanceName: asInstanceName("alpha"), seq: 4, type: "worker.rpcDisconnected" })).toBe("failure");
        expect(activityResult({ at: "2026-07-31T10:00:00Z", instanceName: asInstanceName("alpha"), seq: 5, type: "worker.rpcConnected" })).toBe("success");
        expect(activityResult({ at: "2026-07-31T10:00:00Z", data: { connectionState: "failed" }, instanceName: asInstanceName("alpha"), seq: 6, type: "instance.connectionChanged" })).toBe("failure");
    });
});
