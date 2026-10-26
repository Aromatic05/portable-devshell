import { type JsonValue } from "@portable-devshell/shared";
import { type BoxModel } from "../../../../layout/Box.js";
import type { TuiDomainReader } from "../../../../app/control/Reader.js";
import { type TuiAppState } from "../../../../state/store/Model.js";
import { compactSummary, formatField, makeBox } from "../../Support.js";
import { currentTuiRoute } from "../../../../state/route/State.js";
import { buildReverseConnectionBoxes } from "./Reverse.js";
import { buildConnectorPageBoxes } from "../Connector.js";
import { buildOAuthPageBoxes } from "./OAuth.js";

export function buildConnectionsOverviewBoxes(
    state: TuiAppState,
    reader: TuiDomainReader,
    instance: string | undefined,
): BoxModel[] {
    const entry = reader.instances.instances.find(
        (candidate) => candidate.name === instance,
    );
    const mcp = asRecord(reader.config.view?.mcp);
    const instanceConfig =
        instance !== undefined &&
        Array.isArray(reader.config.view?.instances)
            ? reader.config.view.instances.find(
                  (candidate) => asRecord(candidate)?.name === instance,
              )
            : undefined;
    const instanceRecord = asRecord(instanceConfig);
    const instanceMcp = asRecord(instanceRecord?.mcp);
    const instanceAuth = asRecord(instanceMcp?.auth);
    const provider =
        typeof instanceRecord?.provider === "string"
            ? instanceRecord.provider
            : undefined;
    const authMode =
        typeof instanceAuth?.mode === "string" ? instanceAuth.mode : "none";
    const oauthMode =
        reader.mcp.status?.authMode === "oauth2" ? "oauth2" : authMode;
    const running = reader.mcp.status?.running === true;
    const pendingOAuth = reader.mcp.approvals.filter(
        (approval) => approval.status === "pending",
    ).length;
    const snapshot =
        instance === undefined
            ? undefined
            : reader.runtime(instance).snapshot;
    const enabled =
        instance === undefined
            ? mcp?.enabled === true
            : entry?.mcpEnabled === true;
    const restartPending = state.ui.controlRestartRequired;
    const runtime = restartPending
        ? "restart required"
        : !enabled
          ? "disabled"
          : running
            ? "running"
            : "stopped";
    const path =
        instance === undefined
            ? undefined
            : typeof instanceMcp?.path === "string" &&
                instanceMcp.path.length > 0
              ? instanceMcp.path
              : `/${instance}/mcp`;
    const oauthBlocked =
        authMode === "oauth2" && reader.mcp.status?.oauthReady !== true;
    const usable = !restartPending && running && enabled && !oauthBlocked;
    const publicEndpoint = restartPending
        ? "pending Control restart"
        : usable && path !== undefined
          ? publicMcpEndpoint(mcp?.publicBaseUrl, path)
          : usable && typeof mcp?.publicBaseUrl === "string"
            ? mcp.publicBaseUrl
            : "unavailable";

    return [
        makeBox(state, "connections", instance, {
            detailLines: [
                ...(instance === undefined
                    ? [formatField("Scope", "global")]
                    : []),
                formatField("Enabled", String(enabled)),
                ...(path === undefined ? [] : [formatField("Path", path)]),
                formatField("Runtime", runtime),
                formatField(
                    instance === undefined ? "Public base URL" : "Public MCP",
                    publicEndpoint,
                ),
            ],
            id: "connections:connector:mcp",
            primaryRoute: {
                connectorId: "mcp",
                page: "connections",
                view: "connector",
            },
            status: usable
                ? "ready"
                : !restartPending && !enabled
                  ? "disabled"
                  : "warning",
            summaryLines: [
                compactSummary(
                    ["runtime", runtime],
                    [
                        "scope",
                        instance === undefined ? "global" : (path ?? "-"),
                    ],
                ),
            ],
            title: instance === undefined ? "Global Connector" : "Connector",
        }),
        ...(oauthMode === "oauth2"
            ? [
                  makeBox(state, "connections", instance, {
                      detailLines: [
                          formatField("Provider", oauthMode),
                          formatField(
                              "Ready",
                              restartPending
                                  ? "pending Control restart"
                                  : String(
                                        reader.mcp.status?.oauthReady === true,
                                    ),
                          ),
                          formatField("Pending", String(pendingOAuth)),
                      ],
                      id: "connections:oauth:default",
                      primaryRoute: {
                          page: "connections",
                          providerId: "default",
                          view: "oauth",
                      },
                      status: restartPending
                          ? "warning"
                          : reader.mcp.status?.oauthReady === true
                            ? "ready"
                            : "failed",
                      summaryLines: [
                          compactSummary(
                              ["provider", authMode],
                              ["pending", String(pendingOAuth)],
                          ),
                      ],
                      title: "OAuth Provider",
                  }),
              ]
            : []),
        ...(provider === "reverse" && instance !== undefined
            ? [
                  makeBox(state, "connections", instance, {
                      detailLines: [
                          formatField("Provider", provider),
                          formatField(
                              "Connection",
                              snapshot?.connectionState ?? "unknown",
                          ),
                          formatField(
                              "Daemon",
                              snapshot?.daemonState ?? "unknown",
                          ),
                      ],
                      id: `connections:reverse:${instance}`,
                      primaryRoute: {
                          instanceId: instance,
                          page: "connections",
                          view: "reverse",
                      },
                      status:
                          snapshot?.connectionState === "connected"
                              ? "ready"
                              : "warning",
                      summaryLines: [
                          compactSummary(
                              [
                                  "connection",
                                  snapshot?.connectionState ?? "unknown",
                              ],
                              ["provider", provider],
                          ),
                      ],
                      title: "Reverse Connection",
                  }),
              ]
            : []),
    ];
}

function publicMcpEndpoint(
    publicBaseUrl: JsonValue | undefined,
    path: string,
): string {
    if (typeof publicBaseUrl !== "string" || publicBaseUrl.length === 0)
        return "unavailable";
    try {
        const base = publicBaseUrl.endsWith("/")
            ? publicBaseUrl
            : `${publicBaseUrl}/`;
        return new URL(
            path.startsWith("/") ? path.slice(1) : path,
            base,
        ).toString();
    } catch {
        return "unavailable";
    }
}

function asRecord(
    value: unknown,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : undefined;
}

export function buildConnectionsPageBoxes(
    state: TuiAppState,
    reader: TuiDomainReader,
    instanceName: string | undefined,
): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "connections") return [];
    switch (route.view) {
        case "overview":
            return buildConnectionsOverviewBoxes(state, reader, instanceName);
        case "connector":
            return buildConnectorPageBoxes(state, reader, instanceName);
        case "oauth":
            return buildOAuthPageBoxes(state, reader, instanceName);
        case "reverse":
            return buildReverseConnectionBoxes(
                state,
                reader,
                instanceName ?? route.instanceId,
                route.instanceId,
            );
    }
}
