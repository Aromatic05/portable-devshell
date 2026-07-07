import type { Writable } from "node:stream";

import type { JsonValue } from "../../type/TypeJsonValue.js";
import { FrameCodec } from "./ProtocolFrameCodec.js";

export class FrameWriter {
    readonly #writable: Writable;

    constructor(writable: Writable) {
        this.#writable = writable;
    }

    async write(value: JsonValue): Promise<void> {
        const frame = FrameCodec.encode(value);

        await new Promise<void>((resolve, reject) => {
            this.#writable.write(frame, (error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }
}
