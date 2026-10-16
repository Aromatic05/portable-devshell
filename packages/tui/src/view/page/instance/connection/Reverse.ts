import type { BoxModel } from "../../../component/content/Box.js";
import type { TuiDomainReader } from "../../../domain/Reader.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import { formatField, makeBox } from "../../Support.js";
import { asRecord } from "../../../../state/editor/Draft.js";
import { buttonLine } from "../../../component/Editor.js";

export function buildReverseConnectionBoxes(
    state: TuiAppState,
    reader: TuiDomainReader,
    selectedInstance: string,
    routeInstance: string,
): BoxModel[] {
    const configEntries = reader.config.view?.instances;
    const instanceConfig = Array.isArray(configEntries)
        ? configEntries
              .map((value) => asRecord(value))
              .find((value) => value?.name === routeInstance)
        : undefined;
    const provider =
        typeof instanceConfig?.provider === "string"
            ? instanceConfig.provider
            : "unknown";
    const snapshot = reader.runtime(routeInstance).snapshot;
    return [
        makeBox(state, "connections", selectedInstance, {
            detailLines: [
                formatField("Instance", routeInstance),
                formatField("Provider", provider),
                formatField(
                    "Connection",
                    snapshot?.connectionState ?? "unknown",
                ),
                formatField("Daemon", snapshot?.daemonState ?? "unknown"),
                formatField("Status", snapshot?.status ?? "unknown"),
                formatField("Last sequence", String(snapshot?.lastSeq ?? 0)),
                "",
                "Enrollment",
                "If the code expires, generate another without recreating the instance.",
                buttonLine(
                    `reverse.createCode:${routeInstance}`,
                    "Generate enrollment code",
                    provider !== "reverse",
                ),
                buttonLine(
                    `reverse.revokeToken:${routeInstance}`,
                    "Revoke device credential",
                    provider !== "reverse",
                ),
            ],
            id: `reverse-connection:${routeInstance}`,
            status:
                snapshot?.connectionState === "connected" ? "ready" : "warning",
            summaryLines: [
                `${snapshot?.connectionState ?? "unknown"} · ${snapshot?.daemonState ?? "unknown"}`,
            ],
            title: routeInstance,
        }),
    ];
}
