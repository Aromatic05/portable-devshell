import {
    controlClientModule,
    type ClientConnection,
    type InstanceCreateDraft,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceListEntry,
    type JsonValue
} from "@portable-devshell/shared";

export function createTuiClientInstance(connection: ClientConnection) {
    const instance = controlClientModule(connection, "instance");
    return {
        list: (): Promise<InstanceListEntry[]> => instance.request("list"),
        createSchema: (): Promise<InstanceCreateSchema> => instance.request("createSchema"),
        validateCreate: (draft: InstanceCreateDraft): Promise<InstanceCreateSummary> =>
            instance.request("validateCreate", draft),
        create: (draft: InstanceCreateDraft): Promise<InstanceCreateResult> => instance.request("create", draft),
        enable: (instanceName: string): Promise<Record<string, JsonValue>> =>
            instance.request("enable", { instanceName }),
        disable: (instanceName: string): Promise<Record<string, JsonValue>> =>
            instance.request("disable", { instanceName }),
        delete: (instanceName: string): Promise<Record<string, JsonValue>> =>
            instance.request("delete", { instanceName })
    };
}

export type TuiClientInstance = ReturnType<typeof createTuiClientInstance>;
