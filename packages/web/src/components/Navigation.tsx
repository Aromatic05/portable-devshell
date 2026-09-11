import type { WebApplicationDescriptor } from "@portable-devshell/shared/browser";

import { pageRoute, type WebPage, type WebRoute } from "../routing/hashRoute.js";

const navigation: Array<{ page: WebPage; label: string }> = [
    { page: "overview", label: "Overview" },
    { page: "instances", label: "Instances" },
    { page: "messages", label: "Messages" },
    { page: "audit", label: "Audit" },
    { page: "approvals", label: "Approvals" },
    { page: "todos", label: "Todos" },
];

export function Navigation({
    active,
    applications,
    counts,
    navigate,
}: {
    active: WebRoute;
    applications: readonly WebApplicationDescriptor[];
    counts: { approvals: number; instances: number; todos: number };
    navigate(route: WebRoute): void;
}) {
    return (
        <>
            {navigation.map((item) => {
                const badge = item.page === "approvals" ? counts.approvals : item.page === "instances" ? counts.instances : item.page === "todos" ? counts.todos : undefined;
                return (
                    <button
                        aria-current={active.page === item.page ? "page" : undefined}
                        className={active.page === item.page ? "selected" : ""}
                        key={item.page}
                        onClick={() => navigate(pageRoute(item.page))}
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
