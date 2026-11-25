import { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import {
    TuiComponentTerminal,
    type TuiTerminalRenderSource,
} from "./control/View.js";
import type { TuiSharedTerminalList } from "./SharedList.js";

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
        return (
            <TuiComponentTerminal
                columns={props.columns}
                rows={props.rows}
                focused={props.focused}
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
                        : "↑/↓ select · Enter take control · r refresh · Ctrl+] detach")}
            </Text>
            {state.sessions.length === 0 && !state.loading ? (
                <Text dimColor>No running PTY sessions</Text>
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
                        {session.terminalId} · {session.state}
                    </Text>
                ))}
        </Box>
    );
}
