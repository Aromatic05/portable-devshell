import {
    createInitialControlReadModelState,
    type ControlReadModelState,
} from "@portable-devshell/shared/browser";

export type ConnectionState = "connecting" | "online" | "offline";

export interface WebState {
    connection: ConnectionState;
    error?: string;
    notice?: string;
    operations: Record<string, "pending">;
    readModel: ControlReadModelState;
}

export function createInitialWebState(): WebState {
    return {
        connection: "connecting",
        operations: {},
        readModel: createInitialControlReadModelState(),
    };
}

export function webFailures(
    model: Readonly<ControlReadModelState>,
): Record<string, string> {
    return Object.fromEntries(Object.values(model.failures).map((failure) => {
        if (failure.key === "snapshot") {
            return [`instance:${failure.instance ?? "-"}`, failure.error.message];
        }
        if (failure.key === "todo") {
            return [`todos:${failure.instance ?? "-"}`, failure.error.message];
        }
        return [failure.id, failure.error.message];
    }));
}
