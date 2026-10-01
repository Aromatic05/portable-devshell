import {
    connectControlChannel,
    createPersistentControlClients,
    type ControlChannelOptions,
    type PersistentControlClients,
} from "@portable-devshell/shared";

export interface TuiClientOptions extends ControlChannelOptions {}
export type TuiClients = PersistentControlClients;

export function createTuiClients(options: TuiClientOptions = {}): TuiClients {
    return createPersistentControlClients({
        clientKind: "tui",
        connectChannel: async (signal) =>
            await connectControlChannel(options, signal),
    });
}
