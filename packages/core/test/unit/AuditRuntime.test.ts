import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";
import { createAuditRuntime } from "../../src/audit/index.ts";
import { AuditDatabase } from "../../src/audit/database/index.ts";
import { LogStoreInstance } from "../../src/audit/log/index.ts";

test("AuditRuntime closes its database when the log store close fails", async () => {
    const originalLogClose = LogStoreInstance.prototype.close;
    const originalDatabaseClose = AuditDatabase.prototype.close;
    const logCloseFailure = new Error("log close failed");
    let databaseCloseCalls = 0;
    LogStoreInstance.prototype.close = async () => {
        throw logCloseFailure;
    };
    AuditDatabase.prototype.close = async () => {
        databaseCloseCalls += 1;
    };

    try {
        const runtime = createAuditRuntime({
            eventBufferSize: 8,
            filePath: join(tmpdir(), `audit-close-${randomUUID()}.sqlite`),
            instanceName: asInstanceName("audit-close-test"),
        });

        await assert.rejects(runtime.close(), (error) => error === logCloseFailure);
        assert.equal(databaseCloseCalls, 1);
        await assert.rejects(runtime.close(), (error) => error === logCloseFailure);
        assert.equal(databaseCloseCalls, 1);
    } finally {
        LogStoreInstance.prototype.close = originalLogClose;
        AuditDatabase.prototype.close = originalDatabaseClose;
    }
});
