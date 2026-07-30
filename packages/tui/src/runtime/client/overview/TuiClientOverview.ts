import {
    controlClientModule,
    type ClientConnection,
    type OperationalOverview
} from "@portable-devshell/shared";

export function createTuiClientOverview(connection: ClientConnection) {
    const overview = controlClientModule(connection, "overview");
    return {
        get: (): Promise<OperationalOverview> => overview.request("get")
    };
}

export type TuiClientOverview = ReturnType<typeof createTuiClientOverview>;
