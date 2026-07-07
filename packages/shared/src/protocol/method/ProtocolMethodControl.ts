export const controlMethods = {
    controllerGetConfig: "controller.getConfig",
    controllerListInstances: "controller.listInstances",
    controllerPing: "controller.ping",
    instanceLogs: "instance.logs",
    instanceRpc: "instance.rpc",
    instanceStart: "instance.start",
    instanceStatus: "instance.status",
    instanceStop: "instance.stop",
    toolsCall: "tools.call",
    toolsList: "tools.list"
} as const;

export type ControlMethod = (typeof controlMethods)[keyof typeof controlMethods];
