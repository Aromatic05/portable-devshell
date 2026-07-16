import {
    controlClientModule,
    type ClientConnection,
    type ReverseDeviceCodeResult
} from "@portable-devshell/shared";

export function createCliClientReverse(connection: ClientConnection) {
    const reverse = controlClientModule(connection, "reverse");
    return {
        createCode: (instance: string): Promise<ReverseDeviceCodeResult> =>
            reverse.request("createCode", { instance }),
        rotateToken: (instance: string): Promise<{ deviceToken: string; instance: string }> =>
            reverse.request("rotateToken", { instance }),
        revokeToken: (instance: string): Promise<{ instance: string; revoked: true }> =>
            reverse.request("revokeToken", { instance })
    };
}

export type CliClientReverse = ReturnType<typeof createCliClientReverse>;
