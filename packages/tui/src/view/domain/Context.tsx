import {
    createContext,
    useContext,
    useSyncExternalStore,
    type ReactNode,
} from "react";

import type { TuiDomainSession } from "../../app/control/Client.js";

const TuiDomainContext = createContext<TuiDomainSession | undefined>(undefined);

export function TuiDomainProvider({
    children,
    domains,
}: {
    children: ReactNode;
    domains: TuiDomainSession;
}) {
    return (
        <TuiDomainContext.Provider value={domains}>
            {children}
        </TuiDomainContext.Provider>
    );
}

export function useTuiDomains(): TuiDomainSession {
    const domains = useContext(TuiDomainContext);
    if (domains === undefined)
        throw new Error("TuiDomainProvider is not available.");
    return domains;
}

export interface DomainObservable<State> {
    readonly state: Readonly<State>;
    subscribe(listener: () => void): () => void;
}

export function useDomainSnapshot<State>(
    viewModel: DomainObservable<State>,
): Readonly<State> {
    return useSyncExternalStore(
        (listener) => viewModel.subscribe(listener),
        () => viewModel.state,
        () => viewModel.state,
    );
}
