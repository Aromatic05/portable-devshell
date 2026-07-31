import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { buildAuditPageBoxes } from "./TuiPageAudit.js";
import { buildConfigPageBoxes } from "./TuiPageConfig.js";
import { buildConnectionsPageBoxes } from "./TuiPageConnections.js";
import { buttonLine } from "../editor/TuiEditorView.js";
import { buildHelpPageBoxes } from "./TuiPageHelp.js";
import { buildInstancesPageBoxes } from "./TuiPageInstances.js";
import { buildLogsPageBoxes } from "./TuiPageLogs.js";
import { buildOverviewPageBoxes } from "./TuiPageOverview.js";
import { buildTodoPageBoxes } from "./TuiPageTodo.js";
import { makeBox } from "./TuiPageBoxSupport.js";

export function buildBoxesForPage(state: TuiAppState, page: TuiPageId, instanceName: string | undefined): BoxModel[] {
    const boxes = buildUnfilteredBoxes(state, page, instanceName);
    if (page !== "overview" && page !== "instances" && page !== "todo" && page !== "config" && page !== "audit") {
        return boxes;
    }

    const query = state.ui.searchQueries[page] ?? "";
    if (query.trim().length === 0) return boxes;
    const filtered = page === "audit" ? filterAuditBoxes(boxes, query) : filterBoxes(boxes, query);
    return [filterStatusBox(state, page, instanceName, query, filtered.length, boxes.length), ...filtered];
}

function buildUnfilteredBoxes(state: TuiAppState, page: TuiPageId, instanceName: string | undefined): BoxModel[] {
    switch (page) {
        case "overview":
            return buildOverviewPageBoxes(state);
        case "help":
            return buildHelpPageBoxes(state);
        case "instances":
            return buildInstancesPageBoxes(state);
        case "todo":
            return instanceName === undefined ? [] : buildTodoPageBoxes(state, instanceName);
        case "config":
            return instanceName === undefined ? [] : buildConfigPageBoxes(state, instanceName);
        case "connections":
            return instanceName === undefined ? [] : buildConnectionsPageBoxes(state, instanceName);
        case "audit":
            return instanceName === undefined ? [] : buildAuditPageBoxes(state, instanceName);
        case "logs":
            return instanceName === undefined ? [] : buildLogsPageBoxes(state, instanceName);
        case "terminal":
            return [];
    }
}

function filterStatusBox(state: TuiAppState, page: "overview" | "instances" | "todo" | "config" | "audit", instanceName: string | undefined, query: string, visible: number, total: number): BoxModel {
    return makeBox(state, page, instanceName, {
        detailLines: [
            `Query              ${query}`,
            `Visible            ${visible}`,
            `Total              ${total}`,
            ...(page === "audit" ? ["Syntax             status: risk: source: tool: after: before:"] : []),
            buttonLine("clear-filter", "Clear Filter")
        ],
        id: `${page}-filter-status`,
        status: "warning",
        summaryLines: [`filter=${query}  visible=${visible}/${total}`],
        title: "Active Filter"
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
        const timestamps = [...text.matchAll(/\d{4}-\d{2}-\d{2}T[^\s]+/gu)].map((match) => match[0]!);
        return tokens.every((token) => {
            const separator = token.indexOf(":");
            if (separator <= 0) return text.includes(token.toLowerCase());
            const field = token.slice(0, separator).toLowerCase();
            const value = token.slice(separator + 1).toLowerCase();
            if (field === "after") return timestamps.some((timestamp) => timestamp >= token.slice(separator + 1));
            if (field === "before") return timestamps.some((timestamp) => timestamp <= token.slice(separator + 1));
            if (field === "status" || field === "risk" || field === "source" || field === "tool") {
                return text.includes(`${field} ${value}`) || text.includes(`${field}=${value}`) || text.includes(`· ${value}`);
            }
            return text.includes(token.toLowerCase());
        });
    });
}

function searchableText(box: BoxModel): string {
    return [box.title, box.searchText ?? "", ...box.collapsedLines.map((line) => line.text), ...box.expandedLines.map((line) => line.text)].join("\n").toLowerCase();
}
