import { Worker } from "node:worker_threads";

export interface AuditBackgroundTask {
    cancel(): void;
}

interface AuditWorkerResult {
    checkpointComplete?: boolean;
    error?: string;
    payloadBytes?: number;
}

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let database;
try {
    database = new DatabaseSync(workerData.filePath, { timeout: 5_000 });
    if (workerData.operation === "payloadBackfill") {
        const row = database
            .prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records WHERE id <= ?")
            .get(workerData.highWater);
        parentPort.postMessage({ payloadBytes: Number(row.payloadBytes) });
    } else if (workerData.operation === "walCheckpoint") {
        database.exec("PRAGMA journal_size_limit = 1048576");
        const row = database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        parentPort.postMessage({
            checkpointComplete: Number(row.busy) === 0 && Number(row.checkpointed) >= Number(row.log)
        });
    } else {
        throw new Error("Unknown audit background operation.");
    }
} catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
    database?.close();
}
`;

export function startAuditPayloadBackfill(
    filePath: string,
    highWater: number,
    onComplete: (payloadBytes: number) => void,
    onFailure: () => void
): AuditBackgroundTask {
    return startAuditWorker(
        { filePath, highWater, operation: "payloadBackfill" },
        (message) => {
            if (!Number.isSafeInteger(message.payloadBytes) || message.payloadBytes! < 0) {
                onFailure();
                return;
            }
            onComplete(message.payloadBytes!);
        },
        onFailure
    );
}

export function startAuditWalCheckpoint(
    filePath: string,
    onComplete: (checkpointComplete: boolean) => void,
    onFailure: () => void
): AuditBackgroundTask {
    return startAuditWorker(
        { filePath, operation: "walCheckpoint" },
        (message) => typeof message.checkpointComplete === "boolean"
            ? onComplete(message.checkpointComplete)
            : onFailure(),
        onFailure
    );
}

function startAuditWorker(
    workerData: Record<string, number | string>,
    onMessage: (message: AuditWorkerResult) => void,
    onFailure: () => void
): AuditBackgroundTask {
    const worker = new Worker(workerSource, {
        eval: true,
        execArgv: ["--no-warnings"],
        workerData
    });
    let settled = false;
    const fail = (): void => {
        if (settled) return;
        settled = true;
        onFailure();
    };
    worker.once("message", (message: AuditWorkerResult) => {
        if (settled) return;
        if (message.error !== undefined) {
            fail();
            return;
        }
        settled = true;
        onMessage(message);
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
        if (code !== 0) fail();
    });
    worker.unref();
    return {
        cancel(): void {
            if (settled) return;
            settled = true;
            void worker.terminate();
        }
    };
}
