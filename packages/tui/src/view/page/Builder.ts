import type { BoxModel } from "../component/content/Box.js";
import type { TuiPageId } from "../../state/Ui.js";
import type { TuiAppState } from "../../state/store/Model.js";
import { buildAuditPageBoxes } from "./activity/audit/List.js";
import { buildConfigPageBoxes } from "./instance/Config.js";
import { buildConnectionsPageBoxes } from "./instance/connection/Overview.js";
import { buttonLine } from "../component/Editor.js";
import { buildHelpPageBoxes } from "./Help.js";
import { buildInstancesPageBoxes } from "./instance/Instances.js";
import { buildTodoPageBoxes } from "./workflow/Overview.js";
import { makeBox } from "./Support.js";
import { currentTuiRoute } from "../../state/route/State.js";

export function buildBoxesForPage(
    state: TuiAppState,
    page: TuiPageId,
    instanceName: string | undefined,
): BoxModel[] {
    const boxes = buildUnfilteredBoxes(state, page, instanceName);
    if (
        page !== "instances" &&
        page !== "todo" &&
        page !== "config" &&
        page !== "extensions" &&
        page !== "audit"
    ) {
        return boxes;
    }

    const query = state.ui.searchQueries[page] ?? "";
    if (query.trim().length === 0) return boxes;
    const filtered =
        page === "audit"
            ? filterAuditBoxes(boxes, query)
            : filterBoxes(boxes, query);
    return [
        filterStatusBox(
            state,
            page,
            instanceName,
            query,
            filtered.length,
            boxes.length,
        ),
        ...filtered,
    ];
}

function buildUnfilteredBoxes(
    state: TuiAppState,
    page: TuiPageId,
    instanceName: string | undefined,
): BoxModel[] {
    switch (page) {
        case "overview":
            return [];
        case "help":
            return buildHelpPageBoxes(state);
        case "instances":
            return buildInstancesPageBoxes(state);
        case "todo":
            return instanceName === undefined
                ? []
                : buildTodoPageBoxes(state, instanceName);
        case "config":
            return instanceName === undefined
                ? []
                : buildConfigPageBoxes(state, instanceName);
        case "connections":
            return buildConnectionsPageBoxes(state, instanceName);
        case "messages":
            return [];
        case "audit":
            return instanceName === undefined
                ? []
                : buildAuditPageBoxes(state, instanceName);
        case "extensions":
            return buildExtensionPageBoxes(state);
        case "terminal":
            return [];
    }
}

function buildExtensionPageBoxes(state: TuiAppState): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "extensions") return [];
    if (route.view === "list") {
        return state.readModel.tuiPages.map((page) =>
            makeBox(state, "extensions", undefined, {
                detailLines: [],
                id: `extension:${page.id}`,
                primaryRoute: {
                    page: "extensions",
                    pageId: page.id,
                    view: "page",
                },
                searchText: `${page.extensionId} ${page.id} ${page.title}`,
                summaryLines: [`extension ${page.extensionId}`],
                title: page.title,
            }),
        );
    }
    const snapshot = state.extensionPageSnapshots[route.pageId];
    if (snapshot === undefined) return [];
    return snapshot.items.map((item) =>
        makeBox(state, "extensions", undefined, {
            detailLines: [
                ...(item.detail ?? []).map((line) => ({
                    id: `detail:${line.text}`,
                    text: line.text,
                    tone: line.tone,
                })),
                ...(item.actions ?? []).map((action) => ({
                    id: `button:extension.action:${action.id}`,
                    text: `[ ${action.label} ]`,
                    tone: action.tone === "danger" ? ("danger" as const) : ("accent" as const),
                })),
            ],
            id: item.id,
            searchText: [
                item.title,
                ...item.summary.map((line) => line.text),
                ...(item.detail ?? []).map((line) => line.text),
            ].join(" "),
            status: item.status,
            summaryLines: item.summary.map((line) => line.text),
            title: item.title,
        }),
    );
}

function filterStatusBox(
    state: TuiAppState,
    page: "instances" | "todo" | "config" | "extensions" | "audit",
    instanceName: string | undefined,
    query: string,
    visible: number,
    total: number,
): BoxModel {
    return makeBox(state, page, instanceName, {
        detailLines: [
            `Query              ${query}`,
            `Visible            ${visible}`,
            `Total              ${total}`,
            ...(page === "audit"
                ? [
                      "Syntax             status: risk: source: tool: workspace: after: before:",
                  ]
                : []),
            buttonLine("clear-filter", "Clear Filter"),
        ],
        id: `${page}-filter-status`,
        status: "warning",
        summaryLines: [`filter=${query}  visible=${visible}/${total}`],
        title: "Active Filter",
    });
}

function filterBoxes(boxes: BoxModel[], query: string): BoxModel[] {
    const normalized = query.trim().toLowerCase();
    return boxes.filter((box) => searchableText(box).includes(normalized));
}

function filterAuditBoxes(boxes: BoxModel[], query: string): BoxModel[] {
    const tokens = query.trim().split(/\s+/u).filter(Boolean);
    return boxes.filter((box) => {
        const text = searchableText(box);
        const timestamps = [...text.matchAll(/\d{4}-\d{2}-\d{2}T[^\s]+/gu)].map(
            (match) => match[0]!,
        );
        return tokens.every((token) => {
            const separator = token.indexOf(":");
            if (separator <= 0) return text.includes(token.toLowerCase());
            const field = token.slice(0, separator).toLowerCase();
            const value = token.slice(separator + 1).toLowerCase();
            if (field === "after")
                return timestamps.some(
                    (timestamp) => timestamp >= token.slice(separator + 1),
                );
            if (field === "before")
                return timestamps.some(
                    (timestamp) => timestamp <= token.slice(separator + 1),
                );
            if (field === "workspace") {
                return text.includes(`workspace ${value}`);
            }
            if (
                field === "status" ||
                field === "risk" ||
                field === "source" ||
                field === "tool"
            ) {
                return (
                    text.includes(`${field} ${value}`) ||
                    text.includes(`${field}=${value}`) ||
                    text.includes(`· ${value}`)
                );
            }
            return text.includes(token.toLowerCase());
        });
    });
}

function searchableText(box: BoxModel): string {
    return [
        box.title,
        box.searchText ?? "",
        ...box.collapsedLines.map((line) => line.text),
        ...box.expandedLines.map((line) => line.text),
    ]
        .join("\n")
        .toLowerCase();
}
