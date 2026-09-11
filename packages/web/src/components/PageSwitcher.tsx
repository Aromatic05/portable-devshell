import { useEffect, useRef, useState } from "react";

import type { WebApplicationDescriptor } from "@portable-devshell/shared/browser";

import { pageRoute, type WebPage, type WebRoute } from "../routing/hashRoute.js";

const pages: Array<{ page: WebPage; label: string }> = [
    { page: "overview", label: "Overview" },
    { page: "instances", label: "Instances" },
    { page: "messages", label: "Messages" },
    { page: "audit", label: "Audit" },
    { page: "approvals", label: "Approvals" },
    { page: "todos", label: "Todos" },
];

export function PageSwitcher({
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
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const current = pages.find((item) => item.page === active.page) ?? pages[0]!;

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return <div className="page-switcher" ref={root}>
        <button
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={`Switch page, current ${current.label}`}
            className="page-switcher-trigger"
            onClick={() => setOpen((value) => !value)}
            type="button"
        >
            <span>{current.label}</span>
            <span aria-hidden="true">⌄</span>
        </button>
        {open ? <div aria-label="Pages" className="page-switcher-menu" role="menu">
            {pages.map((item) => {
                const badge = pageBadge(item.page, counts);
                return <button
                    aria-current={active.page === item.page ? "page" : undefined}
                    className={active.page === item.page ? "selected" : ""}
                    key={item.page}
                    onClick={() => {
                        setOpen(false);
                        navigate(pageRoute(item.page));
                    }}
                    role="menuitem"
                    type="button"
                >
                    <span>{item.label}</span>
                    {badge === undefined || badge === 0 ? null : <span className="badge">{badge}</span>}
                </button>;
            })}
            {applications.length === 0 ? null : <>
                <div className="page-switcher-separator" role="separator" />
                <span className="page-switcher-section">Extensions</span>
                {applications.map((application) => <a
                    href={extensionApplicationHref(application.id)}
                    key={`extension:${application.extensionId}:${application.id}`}
                    role="menuitem"
                >{application.title}</a>)}
            </>}
        </div> : null}
    </div>;
}

function pageBadge(
    page: WebPage,
    counts: { approvals: number; instances: number; todos: number },
): number | undefined {
    if (page === "approvals") return counts.approvals;
    if (page === "instances") return counts.instances;
    if (page === "todos") return counts.todos;
    return undefined;
}

export function extensionApplicationHref(id: string): string {
    return `./extensions/${encodeURIComponent(id)}/`;
}
