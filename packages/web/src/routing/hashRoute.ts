import { useEffect, useState } from "react";

export const routes = [
    "overview",
    "instances",
    "approvals",
    "activity",
    "todos",
] as const;

export type Route = (typeof routes)[number];

export function readHashRoute(hash = window.location.hash): Route {
    const route = hash.replace(/^#\//, "").split("/")[0];
    return routes.includes(route as Route) ? (route as Route) : "overview";
}

export function navigate(route: Route): void {
    const nextHash = `#/${route}`;
    if (window.location.hash !== nextHash) {
        window.location.hash = nextHash;
    }
}

export function useHashRoute(): [Route, (route: Route) => void] {
    const [route, setRoute] = useState(readHashRoute);

    useEffect(() => {
        const update = () => setRoute(readHashRoute());
        window.addEventListener("hashchange", update);
        window.addEventListener("popstate", update);
        return () => {
            window.removeEventListener("hashchange", update);
            window.removeEventListener("popstate", update);
        };
    }, []);

    return [route, (nextRoute) => {
        navigate(nextRoute);
        setRoute(nextRoute);
    }];
}
