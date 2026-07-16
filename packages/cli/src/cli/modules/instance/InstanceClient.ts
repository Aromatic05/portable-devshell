import {
    controlClientModule,
    type ClientConnection,
    type InstanceCreateDraft,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceListEntry
} from "@portable-devshell/shared";

export function createInstanceClient(connection: ClientConnection) {
    const instance = controlClientModule(connection, "instance");
    return {
        list: (): Promise<InstanceListEntry[]> => instance.request("list"),
        createSchema: (): Promise<InstanceCreateSchema> => instance.request("createSchema"),
        validateCreate: (draft: InstanceCreateDraft): Promise<InstanceCreateSummary> =>
            instance.request("validateCreate", draft),
        create: (draft: InstanceCreateDraft): Promise<InstanceCreateResult> => instance.request("create", draft)
    };
}

export type InstanceClient = ReturnType<typeof createInstanceClient>;
