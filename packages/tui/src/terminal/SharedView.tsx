import { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { TerminalSessionDescriptor } from "@portable-devshell/shared";
import {
    TuiComponentTerminal,
    type TuiTerminalRenderSource,
} from "./control/View.js";
import type { TuiSharedTerminalList } from "./SharedList.js";

function shortId(terminalId: string): string {
    return terminalId.length > 20 ? terminalId.slice(0, 16) : terminalId;
}

function sessionLabel(session: TerminalSessionDescriptor): string {
    return session.name !== undefined && session.name.length > 0
        ? `${session.name} (${shortId(session.terminalId)})`
        : shortId(session.terminalId);
}

function formatSessionRow(session: TerminalSessionDescriptor): string {
    const parts: string[] = [sessionLabel(session)];
    const badges: string[] = [];
    if (session.persistent) badges.push("persistent");
    if (session.humanControl) badges.push("CONTROL");
    if (badges.length > 0) parts.push(`[${badges.join(" · ")}]`);
    parts.push(`${session.cols}x${session.rows}`);
    const detail =
        session.command !== undefined && session.command.length > 0
            ? session.command
            : session.cwd;
    if (detail !== undefined && detail.length > 0) parts.push(detail);
    return parts.join(" · ");
}

export function TuiComponentSharedTerminals(props: {
    columns: number;
    rows: number;
    focused: boolean;
    instance?: string;
    source: TuiSharedTerminalList;
    terminal: TuiTerminalRenderSource;
    onGraphicsVisibility(visible: boolean): void;
}) {
    const state = useSyncExternalStore(
        (listener) => props.source.subscribe(listener),
        () => props.source.getSnapshot(),
        () => props.source.getSnapshot(),
    );
    if (state.active !== undefined) {
        const mode = state.mode ?? "control";
        const modeBadge = mode === "observe" ? "[OBSERVE]" : "[CONTROL]";
        const headerTitle = `session · ${props.instance ?? "no instance"} · ${sessionLabel(state.active)} ${modeBadge}`;
        const headerControls =
            mode === "observe"
                ? "read-only · t take control · q/Esc back · Ctrl+] sidebar"
                : "Ctrl+] release & sidebar";
        return (
            <TuiComponentTerminal
                columns={props.columns}
                rows={props.rows}
                focused={props.focused}
                headerControls={headerControls}
                headerTitle={headerTitle}
                instance={props.instance}
                source={props.terminal}
                onGraphicsVisibility={props.onGraphicsVisibility}
            />
        );
    }
    const available = Math.max(0, props.rows - 2);
    const start = Math.max(0, state.selectedIndex - available + 1);
    return (
        <Box flexDirection="column" height={props.rows} overflow="hidden">
            <Text bold color={props.focused ? "cyan" : undefined}>
                Sessions · {props.instance ?? "no instance"}
            </Text>
            <Text
                color={state.error === undefined ? undefined : "red"}
                dimColor={state.error === undefined}
                wrap="truncate-end"
            >
                {state.error ??
                    (state.loading
                        ? "Loading sessions…"
                        : "↑/↓ select · Enter control · o observe · n new · x close · r refresh · Ctrl+] sidebar")}
            </Text>
            {state.sessions.length === 0 && !state.loading ? (
                <Text dimColor>
                    No running PTY sessions (press n to create a persistent
                    shell)
                </Text>
            ) : null}
            {state.sessions
                .slice(start, start + available)
                .map((session, index) => (
                    <Text
                        key={session.terminalId}
                        color={
                            start + index === state.selectedIndex
                                ? "cyan"
                                : undefined
                        }
                        wrap="truncate-end"
                    >
                        {start + index === state.selectedIndex ? "> " : "  "}
                        {formatSessionRow(session)}
                    </Text>
                ))}
        </Box>
    );
}
