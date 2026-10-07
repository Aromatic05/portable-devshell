import {
    STREAM_GAP_CODE,
    type InstanceEventRecord,
    type InstanceName,
} from "@portable-devshell/shared";

import type { AuditRuntime } from "../../audit/Api.js";
import type { InstanceEventPort } from "../Api.js";

export interface InstanceEventLog {
    readonly port: InstanceEventPort;
    flush(): Promise<void>;
}

export function createInstanceEventLog(
    audit: AuditRuntime,
    instanceName: InstanceName,
    onReadyChanged: () => Promise<void>,
): InstanceEventLog {
    let appendTail = Promise.resolve();
    const readEvents = (fromSeq = 1) => {
        const lastSeq = audit.api.events.readHighWater();
        const records = audit.api.events.readFrom(fromSeq);
        const nextSeq = audit.api.events.readFrom(1, 1)[0]?.seq ?? lastSeq + 1;
        return fromSeq < nextSeq
            ? {
                  code: STREAM_GAP_CODE as typeof STREAM_GAP_CODE,
                  fromSeq,
                  kind: "gap" as const,
                  lastSeq,
                  nextSeq,
              }
            : { events: records, kind: "events" as const, lastSeq };
    };
    return {
        flush: () => appendTail,
        port: {
            append: (input) => {
                const operation = appendTail.then(async () => {
                    const record: InstanceEventRecord = {
                        ...input,
                        instanceName,
                        seq: audit.api.events.readHighWater() + 1,
                    };
                    await audit.api.events.append(record);
                    if (record.type === "instance.readyChanged")
                        await onReadyChanged();
                    return record;
                });
                appendTail = operation.then(
                    () => undefined,
                    () => undefined,
                );
                return operation;
            },
            cursor: () => audit.api.events.readHighWater(),
            readFrom: readEvents,
        },
    };
}
