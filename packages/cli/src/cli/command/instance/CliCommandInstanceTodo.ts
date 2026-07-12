import type { TodoReadResult } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliControlStream } from "../../control/CliControlStream.js";

export class CliCommandInstanceTodo {
    async execute(
        client: CliControlClientLike,
        instance: string,
        follow: boolean,
        onTodo: (todo: TodoReadResult) => Promise<void> | void,
        maxEvents?: number,
    ): Promise<void> {
        let handled = 0;
        let stream: CliControlStream | undefined;

        try {
            while (true) {
                const envelope = await client.getTodo(instance);
                await onTodo(envelope.todo);

                if (
                    !follow ||
                    (maxEvents !== undefined && handled >= maxEvents)
                ) {
                    return;
                }

                try {
                    stream = await client.subscribeTodo(
                        instance,
                        envelope.lastSeq + 1,
                    );
                    while (maxEvents === undefined || handled < maxEvents) {
                        await stream.nextEvent();
                        handled += 1;
                        const refreshed = await client.getTodo(instance);
                        await onTodo(refreshed.todo);
                    }
                    return;
                } catch (error) {
                    stream?.close();
                    stream = undefined;
                    if (readErrorCode(error) === "stream.gap") {
                        continue;
                    }
                    throw error;
                }
            }
        } finally {
            stream?.close();
        }
    }
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
