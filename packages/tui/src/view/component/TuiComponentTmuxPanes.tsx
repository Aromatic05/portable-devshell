import { useSyncExternalStore } from "react";
import { Box, Text } from "ink";

import type { TuiTmuxPaneTerminalSnapshot } from "../../runtime/terminal/TuiTmuxPaneTerminalSession.js";

export interface TuiTmuxPanesRenderSource {
    getSnapshot(): TuiTmuxPaneTerminalSnapshot;
    subscribe(listener: () => void): () => void;
}

export interface TuiComponentTmuxPanesProps {
    columns: number;
    focused: boolean;
    instance?: string;
    rows: number;
    source: TuiTmuxPanesRenderSource;
}

export function TuiComponentTmuxPanes(props: TuiComponentTmuxPanesProps) {
    const snapshot = useSyncExternalStore(
        (listener) => props.source.subscribe(listener),
        () => props.source.getSnapshot(),
        () => props.source.getSnapshot(),
    );
    const active = snapshot.active;
    const pane = snapshot.panes[snapshot.selectedIndex];
    const help = active?.attached === true
        ? "type to send · Esc view · Ctrl+] sidebar"
        : active === undefined
          ? "↑/↓ pane · Enter open · Ctrl+] sidebar"
          : "←/→ pane · ↑/↓ scroll · Enter attach · Esc close · Ctrl+] sidebar";
    const paneLabel = pane === undefined
        ? "no pane"
        : `${snapshot.selectedIndex + 1}/${snapshot.panes.length} · ${pane.name} · ${pane.status}`;
    const header = `tmux · ${props.instance ?? "no instance"} · ${snapshot.status} · ${paneLabel} · ${help}`;
    const bodyRows = Math.max(0, props.rows - 2);

    return (
        <Box flexDirection="column" height={props.rows + 1} overflow="hidden">
            <Text bold color={props.focused ? "cyan" : undefined} wrap="truncate-end">
                {header}
            </Text>
            {snapshot.error !== undefined ? <Text color="red" wrap="truncate-end">{snapshot.error}</Text> : undefined}
            <Box flexDirection="column" flexGrow={1} overflow="hidden" width={Math.max(1, props.columns)}>
                {active === undefined ? (
                    snapshot.panes.length === 0 ? (
                        <Text dimColor>no panes</Text>
                    ) : (
                        snapshot.panes.slice(0, bodyRows).map((candidate, index) => (
                            <Text
                                backgroundColor={index === snapshot.selectedIndex ? "cyan" : undefined}
                                color={index === snapshot.selectedIndex ? "black" : undefined}
                                key={candidate.id}
                                wrap="truncate-end"
                            >
                                {`${index === snapshot.selectedIndex ? "▶" : " "} ${candidate.name} · ${candidate.status}${candidate.taskId === undefined ? "" : ` · ${candidate.taskId}`}`}
                            </Text>
                        ))
                    )
                ) : (
                    <>
                        {active.warning !== undefined ? <Text color="yellow" wrap="wrap">{active.warning}</Text> : undefined}
                        {active.scroll.visibleLines.slice(0, bodyRows).map((line, row) => (
                            <Box height={1} key={row} overflow="hidden" width={Math.max(1, props.columns)}>
                                <Text wrap="truncate-end">
                                    {line.segments.map((segment, index) => (
                                        <Text
                                            backgroundColor={segment.backgroundColor}
                                            bold={segment.bold}
                                            color={segment.color}
                                            dimColor={segment.dimColor}
                                            inverse={segment.inverse}
                                            italic={segment.italic}
                                            key={`${row}:${index}`}
                                            strikethrough={segment.strikethrough}
                                            underline={segment.underline}
                                        >
                                            {segment.text}
                                        </Text>
                                    ))}
                                </Text>
                            </Box>
                        ))}
                        <Text dimColor wrap="truncate-end">
                            {`line ${active.scroll.offset + 1}/${active.scroll.totalLines}${active.scroll.atBottom ? " (bottom)" : ""} · latest ${active.historyLimit} max`}
                        </Text>
                    </>
                )}
            </Box>
        </Box>
    );
}
