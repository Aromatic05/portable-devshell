import type { TodoReadResult } from "@portable-devshell/shared";

import type { CliClientTodo } from "../../client/todo/CliClientTodo.js";
import { followCliCommandWatchStream } from "../watch/CliCommandWatchStream.js";

export class CliCommandInstanceTodo {
    async execute(
        todoClient: CliClientTodo,
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
        await followCliCommandWatchStream({
            loadFromSeq: load,
            maxEvents,
            async onEvent() {
                await onTodo((await todoClient.get(instance)).todo);
            },
            subscribe: (fromSeq) => todoClient.subscribe(instance, fromSeq)
        });
    }
}
