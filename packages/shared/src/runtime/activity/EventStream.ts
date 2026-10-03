// Thin InstanceEvent specialization of the generic stream reader: it only
// supplies instance-event decoding and the instance-name guard.

import type { MessageStream } from "../../transport/packet/Stream.js";
import { EventStreamReader } from "../../transport/stream/EventStream.js";
import type { InstanceName } from "../identity/Model.js";
import { readInstanceEvent, readInstanceStreamGapPayload } from "./Contract.js";
import type { InstanceEvent } from "./Model.js";

export class InstanceEventStream extends EventStreamReader<InstanceEvent> {
    constructor(instance: InstanceName, stream: MessageStream) {
        super(stream, {
            decodeEvent: (payload) => {
                const event = readInstanceEvent(payload);
                if (event.instanceName !== instance)
                    throw new Error("Subscription contains another instance.");
                return event;
            },
            readGap: readInstanceStreamGapPayload,
        });
    }
}
