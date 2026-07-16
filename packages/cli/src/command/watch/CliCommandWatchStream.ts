import type { CliClientEventStream } from "../../client/CliClientEventStream.js";

export interface CliCommandWatchStreamOptions {
    loadFromSeq(): Promise<number>;
    maxEvents?: number;
    onEvent(): Promise<void>;
    subscribe(fromSeq: number): Promise<CliClientEventStream>;
}

export async function followCliCommandWatchStream(options: CliCommandWatchStreamOptions): Promise<void> {
    let handled = 0;
    let stream: CliClientEventStream | undefined;
    try {
        while (true) {
            const fromSeq = await options.loadFromSeq();
            if (options.maxEvents !== undefined && handled >= options.maxEvents) {
                return;
            }
            try {
                stream = await options.subscribe(fromSeq);
            } catch (error) {
                if (isStreamGap(error)) {
                    continue;
                }
                throw error;
            }
            while (options.maxEvents === undefined || handled < options.maxEvents) {
                try {
                    await stream.nextEvent();
                } catch (error) {
                    stream.close();
                    stream = undefined;
                    if (isStreamGap(error)) {
                        break;
                    }
                    throw error;
                }
                handled += 1;
                await options.onEvent();
            }
            if (stream !== undefined) {
                return;
            }
        }
    } finally {
        stream?.close();
    }
}

function isStreamGap(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "stream.gap";
}
