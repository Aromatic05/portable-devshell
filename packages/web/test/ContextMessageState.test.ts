import { describe, expect, it } from "vitest";

import {
    mergeContextMessage,
    mergeContextMessageList,
} from "../src/state/ContextMessageState.js";

const pending = {
    createdAt: "2026-07-31T00:00:00Z",
    ctxId: "ctx-demo",
    id: "message-1",
    instance: "demo",
    status: "pending" as const,
    text: "Continue.",
};

describe("Context message state", () => {
    it("does not downgrade a delivered record", () => {
        const delivered = {
            ...pending,
            deliveredAt: "2026-07-31T00:00:01Z",
            status: "delivered" as const,
        };
        expect(mergeContextMessage([delivered], pending)).toEqual([delivered]);
    });

    it("keeps locally queued pending messages until a server list confirms them", () => {
        expect(mergeContextMessageList([pending], [])).toEqual([pending]);
        expect(mergeContextMessageList([pending], [{
            ...pending,
            deliveredAt: "2026-07-31T00:00:01Z",
            status: "delivered",
        }])).toEqual([{
            ...pending,
            deliveredAt: "2026-07-31T00:00:01Z",
            status: "delivered",
        }]);
    });
});
