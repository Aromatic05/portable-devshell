import type { WaitRecord } from "@portable-devshell/shared";

import type { WaitDocument } from "../instance/workflow/wait/State.js";

export function migrateWaitDocument(document: WaitDocument): WaitDocument {
    return {
        ...document,
        waits: document.waits.map(migrateDeliveredRecovery),
    };
}

function migrateDeliveredRecovery(record: WaitRecord): WaitRecord {
    if (
        record.status !== "resolved" ||
        record.recoveryMessageSentAt === undefined
    )
        return record;
    const {
        recoveryClaimedAt: _claimedAt,
        recoveryClaimId: _claimId,
        ...rest
    } = record;
    return {
        ...rest,
        consumedAt: record.consumedAt ?? record.recoveryMessageSentAt,
        status: "consumed",
    };
}
