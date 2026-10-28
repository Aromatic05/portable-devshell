import { useEffect, useState } from "react";
import { readMcpAppApprovalInput } from "./Connection.js";
import type { McpAppSession } from "./Session.js";

export function ApprovalInput({ session, approvalId }: { session: McpAppSession; approvalId: string }) {
    const [expanded, setExpanded] = useState(false);
    const [input, setInput] = useState<string>();
    const [failure, setFailure] = useState<string>();
    useEffect(() => {
        if (!expanded) return;
        const controller = new AbortController();
        setInput(undefined);
        setFailure(undefined);
        void readMcpAppApprovalInput(session, approvalId, controller.signal).then((value) => {
            if (!controller.signal.aborted) setInput(value);
        }, () => {
            if (!controller.signal.aborted) setFailure("Approval input unavailable. Close and reopen details to retry.");
        });
        return () => controller.abort();
    }, [expanded, session, approvalId]);
    return <div>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide full input" : "Show full input"}
        </button>
        {expanded && (failure ? <p role="alert">{failure}</p> : input === undefined ? <p role="status">Loading input…</p> :
            <pre tabIndex={0} aria-label="Original approval input"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" }}>{input}</pre>)}
    </div>;
}
