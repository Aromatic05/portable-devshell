import type { TuiAppState } from "../reducer/TuiStoreModel.js";
import type { TuiPageId } from "../TuiUiState.js";
import {
    defaultTuiRouteViewState,
    rootTuiRoute,
    tuiRouteIdentity,
    type TuiRoute,
    type TuiRouteViewState,
} from "./TuiRoute.js";

const CONTEXT_SEPARATOR = "\u0000";

export function tuiRouteContextKey(
    page: TuiPageId,
    instance: string | undefined,
): string {
    return `${page}${CONTEXT_SEPARATOR}${instance ?? "-"}`;
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
    const prefix = rootScoped
        ? `${state.ui.selectedPage}:${state.ui.selectedInstance}`
        : tuiRouteViewKey(
              state.ui.selectedPage,
              state.ui.selectedInstance,
              route,
          );
    return `${prefix}:${itemId}`;
}

export function transitionTuiRouteContext(
    state: TuiAppState,
    page: TuiPageId,
    instance: string | undefined,
): TuiAppState {
    const sidebarScope =
        state.interaction.focusScope === "sidebarPages" ||
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
    let changed = false;
    const routeStacks: Record<string, readonly TuiRoute[]> = {};
    for (const [key, stack] of Object.entries(state.ui.routeStacks)) {
        const separator = key.indexOf(CONTEXT_SEPARATOR);
        const instanceValue = key.slice(separator + 1);
        const instance = instanceValue === "-" ? undefined : instanceValue;
        let validLength = 1;
        for (let index = 1; index < stack.length; index += 1) {
            if (!isTuiRouteResourceValid(state, stack[index]!, instance)) break;
            validLength = index + 1;
        }
        routeStacks[key] = stack.slice(0, validLength);
        changed ||= validLength !== stack.length;
    }
    if (!changed) return state;
    return restoreCurrentTuiRouteView({
        ...state,
        ui: { ...state.ui, routeStacks },
    });
}

export function selectBreadcrumbSegments(state: TuiAppState): string[] {
    const route = currentTuiRoute(state);
    const segments: string[] = [route.page];
    switch (route.page) {
        case "audit":
            if (route.view === "context" || route.view === "conversation" || route.view === "call") {
                segments.push(
                    route.scope === "unscoped"
                        ? "unscoped"
                        : truncateTuiBreadcrumbSegment(route.ctxId),
                );
            }
            if (route.view === "conversation") {
                segments.push("conversation");
            }
            if (route.view === "call") {
                segments.push(truncateTuiBreadcrumbSegment(route.callId));
            }
            break;
        case "todo":
            if (route.view === "detail")
                segments.push(resolveTodoBreadcrumbTitle(state, route.todoId));
            break;
        case "logs":
            if (route.view === "context") {
                segments.push(
                    route.scope === "unscoped"
                        ? "unscoped"
                        : truncateTuiBreadcrumbSegment(route.ctxId),
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
    todoId: string,
): string {
    const instance = state.ui.selectedInstance;
    const todo =
        instance === undefined ? undefined : state.todoByInstance[instance];
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
    const focusScope = forceMainFocus ? "mainBoxes" : view.focusRegion;
    const scrollKey = currentTuiRouteScrollKey(state);
    return {
        ...state,
        interaction: { ...state.interaction, focusScope },
        ui: {
            ...state.ui,
            mainFocusId: view.selectedItemId,
            scrollOffsets: {
                ...state.ui.scrollOffsets,
                [scrollKey]: view.scrollOffset,
            },
        },
    };
}

function isPersistentFocusScope(
    scope: TuiAppState["interaction"]["focusScope"],
): boolean {
    return (
        scope === "sidebarPages" ||
        scope === "sidebarInstances" ||
        scope === "mainBoxes" ||
        scope === "boxDetail" ||
        scope === "form" ||
        scope === "wizard" ||
        scope === "terminal"
    );
}

function isTuiRouteResourceValid(
    state: TuiAppState,
    route: TuiRoute,
    instance: string | undefined,
): boolean {
    if (route.page === "audit" && route.view !== "contexts") {
        if (instance === undefined) return false;
        const calls = state.toolCallsByInstance[instance] ?? [];
        const approvals = state.approvalsByInstance[instance] ?? [];
        const messages = state.contextMessagesByInstance[instance] ?? [];
        if (route.scope === "unscoped") {
            return route.view === "context"
                ? calls.some(
                      (call) =>
                          call.ctxId === undefined || call.ctxId.length === 0,
                  ) ||
                      approvals.some(
                          (approval) =>
                              approval.ctxId === undefined ||
                              approval.ctxId.length === 0,
                      )
                : calls.some(
                      (call) =>
                          call.callId === route.callId &&
                          (call.ctxId === undefined || call.ctxId.length === 0),
                  );
        }
        if (route.view === "context" || route.view === "conversation") {
            return (
                calls.some((call) => call.ctxId === route.ctxId) ||
                approvals.some((approval) => approval.ctxId === route.ctxId) ||
                messages.some((message) => message.ctxId === route.ctxId)
            );
        }
        return false;
    }
    if (route.page === "todo" && route.view === "detail") {
        if (instance === undefined) return false;
        const todo = state.todoByInstance[instance];
        return (
            todo?.taskId === route.todoId ||
            todo?.tasks?.some((task) => task.taskId === route.todoId) === true
        );
    }
    if (route.page === "logs" && route.view === "context") {
        if (instance === undefined) return false;
        const logs = state.logsByInstance[instance] ?? [];
        return route.scope === "unscoped"
            ? logs.some(
                  (entry) =>
                      entry.ctxId === undefined || entry.ctxId.length === 0,
              )
            : logs.some((entry) => entry.ctxId === route.ctxId);
    }
    return true;
}

function assertRoutePage(state: TuiAppState, route: TuiRoute): void {
    if (route.page !== state.ui.selectedPage) {
        throw new Error(
            `Cannot navigate to ${route.page} while ${state.ui.selectedPage} is selected.`,
        );
    }
}
