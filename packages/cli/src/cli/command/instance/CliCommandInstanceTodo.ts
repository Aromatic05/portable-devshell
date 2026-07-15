import type { TodoReadResult } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
import { followControlStream } from "../watch/CliCommandFollowStream.js";

export class CliCommandInstanceTodo {
    async execute(
        client: CliControlClientLike,
        instance: string,
        follow: boolean,
        onTodo: (todo: TodoReadResult) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        const load = async () => {
            const envelope = await client.getTodo(instance);
            await onTodo(envelope.todo);
            return envelope.lastSeq + 1;
        };

        if (!follow) {
            await load();
            return;
        }

        await followControlStream({
            loadFromSeq: load,
            maxEvents,
            async onEvent() {
                await onTodo((await client.getTodo(instance)).todo);
            },
            subscribe: (fromSeq) => client.subscribeTodo(instance, fromSeq)
        });
    }
}
