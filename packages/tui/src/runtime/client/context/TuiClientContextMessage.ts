import {
    instanceClientModule,
    type ClientConnection,
    type ContextMessageQueueInput,
    type ContextMessageRecord
} from "@portable-devshell/shared";

export function createTuiClientContextMessage(connection: ClientConnection) {
    const contextMessage = instanceClientModule(connection, "contextMessage");
    return {
        list: (instance: string, ctxId?: string): Promise<ContextMessageRecord[]> =>
            contextMessage.request(instance, "list", ctxId === undefined ? {} : { ctxId }),
        queue: (instance: string, input: ContextMessageQueueInput): Promise<ContextMessageRecord> =>
            contextMessage.request(instance, "queue", input)
    };
}

export type TuiClientContextMessage = ReturnType<typeof createTuiClientContextMessage>;
