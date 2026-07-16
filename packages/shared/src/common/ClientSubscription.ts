import type { JsonValue } from "../type/TypeJsonValue.js";
import type { InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import type { Event } from "../transport/Codec.js";

export function readClientSubscriptionEvents(
    destination: InstanceName,
    payload: JsonValue | undefined
): Event[] {
    if (!isRecord(payload) || !Array.isArray(payload.events)) {
        throw new Error("Invalid subscription acknowledgement.");
    }

    return payload.events.map((value) => {
        if (!isRecord(value) || typeof value.type !== "string" || typeof value.seq !== "number") {
            throw new Error("Invalid initial subscription event.");
        }

        return {
            destination,
            name: value.type as Event["name"],
            payload: value,
            seq: value.seq
        };
    });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
