import type { TuiAppState } from "../store/Model.js";
import type { TuiPageId } from "../Ui.js";
import type { TuiDomainReader } from "../../view/domain/Reader.js";
import {
    defaultTuiRouteViewState,
    rootTuiRoute,
    tuiRouteIdentity,
    type TuiRoute,
    type TuiRouteViewState,
} from "./Model.js";

const CONTEXT_SEPARATOR = "\u0000";

export function tuiRouteContextKey(
    page: TuiPageId,
    instance: string | undefined,
): string {
    return `${page}${CONTEXT_SEPARATOR}${routeContextInstance(page, instance) ?? "-"}`;
}

export function tuiRouteViewKey(
    page: TuiPageId,
    instance: string | undefined,
    route: TuiRoute,
): string {
    return `${tuiRouteContextKey(page, instance)}${CONTEXT_SEPARATOR}${tuiRouteIdentity(route)}`;
}

export function currentTuiRoute(state: TuiAppState): TuiRoute {
    const stack = currentTuiRouteStack(state);
    return stack.at(-1) ?? rootTuiRoute(state.ui.selectedPage);
}

export function currentTuiRouteStack(state: TuiAppState): readonly TuiRoute[] {
    const key = tuiRouteContextKey(
        state.ui.selectedPage,
        state.ui.selectedInstance,
    );
    return state.ui.routeStacks[key] ?? [rootTuiRoute(state.ui.selectedPage)];
}

export function currentTuiRouteViewState(
    state: TuiAppState,
): TuiRouteViewState {
    const route = currentTuiRoute(state);
    return (
        state.ui.routeViewStates[
            tuiRouteViewKey(
                state.ui.selectedPage,
                state.ui.selectedInstance,
                route,
            )
        ] ?? defaultTuiRouteViewState()
    );
}

export function currentTuiRouteScrollKey(state: TuiAppState): string {
    return `${tuiRouteViewKey(state.ui.selectedPage, state.ui.selectedInstance, currentTuiRoute(state))}${CONTEXT_SEPARATOR}main`;
}

export function currentTuiRouteItemKey(
    state: TuiAppState,
    itemId: string,
): string {
    const route = currentTuiRoute(state);
    const rootScoped =
        route.view === "list" ||
        route.view === "summary" ||
        route.view === "overview" ||
        route.view === "contexts" ||
        route.view === "index" ||
        route.view === "session";
    const scopedInstance = routeContextInstance(
        state.ui.selectedPage,
        state.ui.selectedInstance,
    );
    const prefix = rootScoped
        ? `${state.ui.selectedPage}:${scopedInstance}`
        : tuiRouteViewKey(state.ui.selectedPage, scopedInstance, route);
    return `${prefix}:${itemId}`;
}

export function transitionTuiRouteContext(
    state: TuiAppState,
    page: TuiPageId,
    instance: string | undefined,
): TuiAppState {
    const sidebarScope =
        state.interaction.focusScope === "sidebarContext" ||
        state.interaction.focusScope === "sidebarInstances"
            ? state.interaction.focusScope
            : undefined;
    const saved = persistCurrentTuiRouteView(state);
    const key = tuiRouteContextKey(page, instance);
    const routeStacks =
        saved.ui.routeStacks[key] === undefined
            ? { ...saved.ui.routeStacks, [key]: [rootTuiRoute(page)] }
            : saved.ui.routeStacks;
    const restored = restoreCurrentTuiRouteView({
        ...saved,
        ui: {
            ...saved.ui,
            routeStacks,
            selectedInstance: instance,
            selectedPage: page,
        },
    });
    if (sidebarScope === undefined) return restored;
    return {
        ...restored,
        interaction: { ...restored.interaction, focusScope: sidebarScope },
    };
}

export function pushTuiRoute(state: TuiAppState, route: TuiRoute): TuiAppState {
    assertRoutePage(state, route);
    const saved = persistCurrentTuiRouteView(state);
    const key = tuiRouteContextKey(
        saved.ui.selectedPage,
        saved.ui.selectedInstance,
    );
    const stack = saved.ui.routeStacks[key] ?? [
        rootTuiRoute(saved.ui.selectedPage),
    ];
    return restoreCurrentTuiRouteView(
        {
            ...saved,
            ui: {
                ...saved.ui,
                routeStacks: {
                    ...saved.ui.routeStacks,
                    [key]: [...stack, route],
                },
            },
        },
        true,
    );
}

export function popTuiRoute(state: TuiAppState): TuiAppState {
    const stack = currentTuiRouteStack(state);
    if (stack.length <= 1) return state;
    const saved = persistCurrentTuiRouteView(state);
    const key = tuiRouteContextKey(
        saved.ui.selectedPage,
        saved.ui.selectedInstance,
    );
    return restoreCurrentTuiRouteView({
        ...saved,
        ui: {
            ...saved.ui,
            routeStacks: { ...saved.ui.routeStacks, [key]: stack.slice(0, -1) },
        },
    });
}

export function replaceTuiRoute(
    state: TuiAppState,
    route: TuiRoute,
): TuiAppState {
    assertRoutePage(state, route);
    const saved = persistCurrentTuiRouteView(state);
    const key = tuiRouteContextKey(
        saved.ui.selectedPage,
        saved.ui.selectedInstance,
    );
    const stack = saved.ui.routeStacks[key] ?? [
        rootTuiRoute(saved.ui.selectedPage),
    ];
    return restoreCurrentTuiRouteView(
        {
            ...saved,
            ui: {
                ...saved.ui,
                routeStacks: {
                    ...saved.ui.routeStacks,
                    [key]: [...stack.slice(0, -1), route],
                },
            },
        },
        true,
    );
}

export function resetTuiRoute(state: TuiAppState): TuiAppState {
    const saved = persistCurrentTuiRouteView(state);
    const key = tuiRouteContextKey(
        saved.ui.selectedPage,
        saved.ui.selectedInstance,
    );
    return restoreCurrentTuiRouteView({
        ...saved,
        ui: {
            ...saved.ui,
            routeStacks: {
                ...saved.ui.routeStacks,
                [key]: [rootTuiRoute(saved.ui.selectedPage)],
            },
        },
    });
}

export function updateCurrentTuiRouteView(
    state: TuiAppState,
    update: (view: TuiRouteViewState) => TuiRouteViewState,
): TuiAppState {
    const route = currentTuiRoute(state);
    const key = tuiRouteViewKey(
        state.ui.selectedPage,
        state.ui.selectedInstance,
        route,
    );
    const current = state.ui.routeViewStates[key] ?? defaultTuiRouteViewState();
    return {
        ...state,
        ui: {
            ...state.ui,
            routeViewStates: {
                ...state.ui.routeViewStates,
                [key]: update(current),
            },
        },
    };
}

export function reconcileTuiRouteResources(state: TuiAppState): TuiAppState {
    return state;
}

export function selectBreadcrumbSegments(
    state: TuiAppState,
    domains: TuiDomainReader,
): string[] {
    const route = currentTuiRoute(state);
    const segments: string[] = [route.page];
    switch (route.page) {
        case "messages":
            if (route.view === "thread") {
                segments.push(truncateTuiBreadcrumbSegment(route.ctxId));
            }
            break;
        case "audit":
            if (route.view === "context" || route.view === "conversation") {
                segments.push(
                    route.scope === "unscoped"
                        ? "unscoped"
                        : truncateTuiBreadcrumbSegment(route.ctxId),
                );
            }
            if (route.view === "conversation") {
                segments.push("conversation");
            }
            break;
        case "todo":
            if (route.view === "detail")
                segments.push(
                    resolveTodoBreadcrumbTitle(
                        state,
                        domains,
                        route.todoId,
                    ),
                );
            break;
        case "extensions":
            if (route.view === "page") {
                const descriptor = domains.extension.tuiPages.find(
                    (page) => page.id === route.pageId,
                );
                segments.push(
                    truncateTuiBreadcrumbSegment(
                        descriptor?.title ?? route.pageId,
                    ),
                );
            }
            break;
        case "connections":
            if (route.view === "connector")
                segments.push(
                    "connector",
                    truncateTuiBreadcrumbSegment(route.connectorId),
                );
            if (route.view === "oauth")
                segments.push(
                    "oauth",
                    truncateTuiBreadcrumbSegment(route.providerId),
                );
            if (route.view === "reverse")
                segments.push(
                    "reverse",
                    truncateTuiBreadcrumbSegment(route.instanceId),
                );
            break;
    }
    return segments;
}

function resolveTodoBreadcrumbTitle(
    state: TuiAppState,
    domains: TuiDomainReader,
    todoId: string,
): string {
    const instance = state.ui.selectedInstance;
    const todo =
        instance === undefined
            ? undefined
            : domains.todo(instance).todo;
    const title =
        todo?.taskId === todoId
            ? todo.title
            : todo?.tasks?.find((task) => task.taskId === todoId)?.title;
    return truncateTuiBreadcrumbSegment(title ?? todoId);
}

export function truncateTuiBreadcrumbSegment(value: string): string {
    return value.length <= 16
        ? value
        : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function persistCurrentTuiRouteView(state: TuiAppState): TuiAppState {
    const route = currentTuiRoute(state);
    const key = tuiRouteViewKey(
        state.ui.selectedPage,
        state.ui.selectedInstance,
        route,
    );
    const scrollKey = currentTuiRouteScrollKey(state);
    const previous =
        state.ui.routeViewStates[key] ?? defaultTuiRouteViewState();
    const focusRegion = isPersistentFocusScope(state.interaction.focusScope)
        ? state.interaction.focusScope
        : previous.focusRegion;
    return {
        ...state,
        ui: {
            ...state.ui,
            routeViewStates: {
                ...state.ui.routeViewStates,
                [key]: {
                    ...previous,
                    focusRegion,
                    scrollOffset:
                        state.ui.scrollOffsets[scrollKey] ??
                        previous.scrollOffset,
                    selectedItemId: state.ui.mainFocusId,
                },
            },
        },
    };
}

function restoreCurrentTuiRouteView(
    state: TuiAppState,
    forceMainFocus = false,
): TuiAppState {
    const view = currentTuiRouteViewState(state);
    const route = currentTuiRoute(state);
    const focusScope = forceMainFocus ? "mainBoxes" : view.focusRegion;
    const scrollKey = currentTuiRouteScrollKey(state);
    const scrollOffset =
        route.page === "messages" && route.view === "thread"
            ? Number.MAX_SAFE_INTEGER
            : view.scrollOffset;
    return {
        ...state,
        interaction: { ...state.interaction, focusScope },
        ui: {
            ...state.ui,
            mainFocusId: view.selectedItemId,
            scrollOffsets: {
                ...state.ui.scrollOffsets,
                [scrollKey]: scrollOffset,
            },
        },
    };
}

function isPersistentFocusScope(
    scope: TuiAppState["interaction"]["focusScope"],
): boolean {
    return (
        scope === "sidebarContext" ||
        scope === "sidebarInstances" ||
        scope === "mainBoxes" ||
        scope === "boxDetail" ||
        scope === "form" ||
        scope === "wizard" ||
        scope === "terminal"
    );
}

function routeContextInstance(
    page: TuiPageId,
    instance: string | undefined,
): string | undefined {
    return page === "messages" || page === "extensions" ? undefined : instance;
}

function assertRoutePage(state: TuiAppState, route: TuiRoute): void {
    if (route.page !== state.ui.selectedPage) {
        throw new Error(
            `Cannot navigate to ${route.page} while ${state.ui.selectedPage} is selected.`,
        );
    }
}
