import type { Route } from "../routing/hashRoute.js";
import type { WebApplicationDescriptor } from "@portable-devshell/shared/browser";

const navigation: Array<{ route: Route; label: string; badge?: number }> = [
    { route: "overview", label: "Overview" },
    { route: "instances", label: "Instances" },
    { route: "approvals", label: "Approvals" },
    { route: "activity", label: "Audit" },
    { route: "todos", label: "Todos" },
];

export function Navigation({
    active,
    applications,
    counts,
    navigate,
}: {
    active: Route;
    applications: readonly WebApplicationDescriptor[];
    counts: { approvals: number; instances: number; todos: number };
    navigate(route: Route): void;
}) {
    return (
        <>
            {navigation.map((item) => {
                const badge = item.route === "approvals" ? counts.approvals : item.route === "instances" ? counts.instances : item.route === "todos" ? counts.todos : undefined;
                return (
                    <button
                        aria-current={active === item.route ? "page" : undefined}
                        className={active === item.route ? "selected" : ""}
                        key={item.route}
                        onClick={() => navigate(item.route)}
                    >
                        {item.label}{badge !== undefined && badge > 0 ? <span className="badge">{badge}</span> : null}
                    </button>
                );
            })}
            {applications.map((application) => (
                <a
                    className="nav-application"
                    href={extensionApplicationHref(application.id)}
                    key={`extension:${application.extensionId}:${application.id}`}
                >
                    {application.title}
                </a>
            ))}
        </>
    );
}

export function extensionApplicationHref(id: string): string {
    return `./extensions/${encodeURIComponent(id)}/`;
}
