import type { TodoReadResult } from "@portable-devshell/shared";

import type { TodoClient } from "../../modules/todo/TodoClient.js";
import { followControlStream } from "../watch/CliCommandFollowStream.js";

export class CliCommandInstanceTodo {
    async execute(
        todoClient: TodoClient,
        instance: string,
        follow: boolean,
        onTodo: (todo: TodoReadResult) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        const load = async () => {
            const envelope = await todoClient.get(instance);
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
                await onTodo((await todoClient.get(instance)).todo);
            },
            subscribe: (fromSeq) => todoClient.subscribe(instance, fromSeq)
        });
    }
}
