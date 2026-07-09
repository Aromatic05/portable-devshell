export type RouteScope = "control" | "instance";

const methodScopes = new Map<string, RouteScope>([
    ["control.ping", "control"],
    ["control.status", "control"],
    ["control.shutdown", "control"],
    ["control.listInstances", "control"],
    ["control.getInstanceCreateSchema", "control"],
    ["control.validateInstanceCreateDraft", "control"],
    ["control.createInstance", "control"],
    ["instance.getSnapshot", "instance"],
    ["instance.start", "instance"],
    ["instance.stop", "instance"],
    ["instance.refreshStatus", "instance"],
    ["instance.readLogs", "instance"],
    ["instance.readToolCalls", "instance"],
    ["instance.subscribe", "instance"],
    ["instance.callTool", "instance"]
]);

export class RouteMethodRegistry {
    resolve(method: string): RouteScope | undefined {
        return methodScopes.get(method);
    }
}
