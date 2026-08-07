import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildReverseConnectionBoxes(state: TuiAppState, selectedInstance: string, routeInstance: string): BoxModel[] {
    const entry = state.instances.find((candidate) => candidate.name === routeInstance);
    const snapshot = state.readModel.instanceState[routeInstance]?.snapshot;
    return [makeBox(state, "connections", selectedInstance, {
        detailLines: [
            formatField("Instance", routeInstance),
            formatField("Provider", entry?.provider ?? "unknown"),
            formatField("Connection", snapshot?.connectionState ?? "unknown"),
            formatField("Daemon", snapshot?.daemonState ?? "unknown"),
            formatField("Status", snapshot?.status ?? "unknown"),
            formatField("Last sequence", String(snapshot?.lastSeq ?? 0))
        ],
        id: `reverse-connection:${routeInstance}`,
        status: snapshot?.connectionState === "connected" ? "ready" : "warning",
        summaryLines: [`${snapshot?.connectionState ?? "unknown"} · ${snapshot?.daemonState ?? "unknown"}`],
        title: routeInstance
    })];
}
