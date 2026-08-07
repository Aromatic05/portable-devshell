import type { TuiAppStore } from "../../state/TuiAppStore.js";
import { selectTuiLogs } from "../../state/reducer/TuiStoreModel.js";
import type { TuiRouteLifecycleContext } from "./TuiRouteLifecycleController.js";
import type { TuiControlSession } from "../control/TuiControlSession.js";

export class TuiRouteDataLoader {
    constructor(private readonly options: {
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async enter(context: TuiRouteLifecycleContext): Promise<void | (() => void)> {
        const { instance, route, signal } = context;
        switch (route.page) {
            case "overview":
                await this.options.session.refreshOverview(undefined, signal);
                return;
            case "instances":
            case "config":
                await this.options.session.refreshConfig(undefined, signal);
                return;
            case "connections":
                await Promise.all([
                    this.options.session.refreshConfig(undefined, signal),
                    this.options.session.refreshOAuth(undefined, signal)
                ]);
                return;
            case "audit":
                if (instance !== undefined) await this.options.session.refreshAudit(instance, undefined, signal);
                return;
            case "todo":
                if (instance !== undefined) {
                    const title = route.view === "detail"
                        ? this.options.store.getState().readModel.instanceState[instance]?.todo?.tasks?.find(
                              (task) => task.taskId === route.todoId,
                          )?.title
                        : undefined;
                    await this.options.session.refreshTodo(instance, undefined, signal, title);
                }
                return;
            case "logs":
                if (instance === undefined) return;
                if (route.view === "context") {
                    this.options.store.setLogsFollow(instance, true);
                    await this.options.session.refreshLogsForInstance(instance, undefined, signal);
                    return () => {
                        const logs = selectTuiLogs(this.options.store.getState(), instance);
                        this.options.store.setLogsFollow(instance, false);
                        this.options.store.setLogsPausedAtSeq(instance, logs.at(-1)?.seq);
                    };
                }
                return;
            case "help":
            case "terminal":
                return;
        }
    }
}
