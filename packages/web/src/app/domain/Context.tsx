import {
    createContext,
    useCallback,
    useContext,
    useSyncExternalStore,
    type ReactNode,
} from "react";

import type { WebDomainSession } from "./Session.js";

const WebDomainContext = createContext<WebDomainSession | undefined>(undefined);

export function WebDomainProvider({
    children,
    domains,
}: {
    children: ReactNode;
    domains: WebDomainSession;
}) {
    return (
        <WebDomainContext.Provider value={domains}>
            {children}
        </WebDomainContext.Provider>
    );
}

export function useWebDomains(): WebDomainSession {
    const domains = useContext(WebDomainContext);
    if (domains === undefined)
        throw new Error("WebDomainProvider is not available.");
    return domains;
}

export interface DomainObservable<State> {
    readonly state: Readonly<State>;
    subscribe(listener: () => void): () => void;
}

export function useDomainSnapshot<State>(
    viewModel: DomainObservable<State>,
): Readonly<State> {
    const subscribe = useCallback(
        (listener: () => void) => viewModel.subscribe(listener),
        [viewModel],
    );
    const getSnapshot = useCallback(() => viewModel.state, [viewModel]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
