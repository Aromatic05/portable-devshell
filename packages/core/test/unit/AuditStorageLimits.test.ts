import assert from "node:assert/strict";
import test from "node:test";

import { defaultAuditStorageLimits } from "../../src/audit/AuditStorageLimits.ts";

test("Audit storage defaults to a 1 GiB fuse and keeps seven day retention", () => {
    assert.deepEqual(defaultAuditStorageLimits, {
        maxBytes: 1024 * 1024 * 1024,
        retentionDays: 7,
    });
});
