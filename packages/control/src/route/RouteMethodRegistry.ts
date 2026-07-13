export type RouteScope = "control" | "instance";

const methodScopes = new Map<string, RouteScope>([
    ["control.identifyClient", "control"],
    ["control.ping", "control"],
    ["control.status", "control"],
    ["control.getMcpStatus", "control"],
    ["control.shutdown", "control"],
    ["control.restart", "control"],
    ["control.listInstances", "control"],
    ["control.getConfigView", "control"],
    ["control.validateConfigDraft", "control"],
    ["control.getInstanceCreateSchema", "control"],
    ["control.validateInstanceCreateDraft", "control"],
    ["control.createInstance", "control"],
    ["control.createReverseDeviceCode", "control"],
    ["control.updateInstanceConfig", "control"],
    ["control.updateMcpConfig", "control"],
    ["control.deleteInstance", "control"],
    ["control.enableInstance", "control"],
    ["control.disableInstance", "control"],
    ["control.rotateReverseDeviceToken", "control"],
    ["control.revokeReverseDeviceToken", "control"],
    ["control.applyConfig", "control"],
    ["control.listOAuthApprovals", "control"],
    ["control.decideOAuthApproval", "control"],
    ["control.artifact.createShare", "control"],
    ["control.artifact.listShares", "control"],
    ["control.artifact.revokeShare", "control"],
    ["control.artifact.startTransfer", "control"],
    ["control.artifact.getTransfer", "control"],
    ["control.artifact.listTransfers", "control"],
    ["control.artifact.cancelTransfer", "control"],
    ["instance.getSnapshot", "instance"],
    ["instance.start", "instance"],
    ["instance.stop", "instance"],
    ["instance.refreshStatus", "instance"],
    ["instance.readLogs", "instance"],
    ["instance.readToolCalls", "instance"],
    ["instance.listApprovals", "instance"],
    ["instance.getApproval", "instance"],
    ["instance.decideApproval", "instance"],
    ["instance.subscribe", "instance"],
    ["instance.todo.get", "instance"],
    ["instance.todo.subscribe", "instance"],
    ["instance.callTool", "instance"]
]);

export class RouteMethodRegistry {
    resolve(method: string): RouteScope | undefined {
        return methodScopes.get(method);
    }
}
