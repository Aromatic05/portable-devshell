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

    const listWidth = Math.max(16, Math.floor(props.columns * 0.3));
    const panelWidth = Math.max(10, props.columns - listWidth - 1);
    const active = snapshot.active;
    const mode = active === undefined ? "list" : active.attached ? "attach" : "view";
    const help =
        mode === "attach"
            ? "type to send · Ctrl+[ exit"
            : mode === "view"
                ? "↑/↓ scroll · Esc back"
                : "↑/↓ select · Enter open";
    const header = `tmux panes · ${props.instance ?? "no instance"} · ${snapshot.status}${active === undefined ? "" : ` · ${active.name} ${active.attached ? "(attached)" : "(view)"}`} · ${help}`;
    const bodyRows = Math.max(0, props.rows - 1);

    return (
        <Box flexDirection="column" height={props.rows + 1} overflow="hidden">
            <Text bold color={props.focused ? "cyan" : undefined} wrap="truncate-end">
                {header}
            </Text>
            {snapshot.error !== undefined ? <Text color="red" wrap="truncate-end">{snapshot.error}</Text> : undefined}
            <Box flexGrow={1}>
                <Box flexDirection="column" overflow="hidden" width={listWidth}>
                    {snapshot.panes.map((pane, index) => (
                        <Text
                            color={pane.mode === "attach" ? "green" : undefined}
                            inverse={index === snapshot.selectedIndex}
                            key={pane.id}
                            wrap="truncate-end"
                        >
                            {`${index === snapshot.selectedIndex ? "▸" : " "} ${pane.name} ${pane.mode === "attach" ? "Attach" : "View"} ${pane.status}`}
                        </Text>
                    ))}
                    {snapshot.panes.length === 0 ? <Text dimColor>no panes</Text> : undefined}
                </Box>
                <Box flexDirection="column" flexGrow={1} overflow="hidden" width={panelWidth}>
                    {active === undefined ? (
                        <Text dimColor>select a pane and press Enter</Text>
                    ) : (
                        <>
                            {active.warning !== undefined ? <Text color="yellow" wrap="wrap">{active.warning}</Text> : undefined}
                            {active.scroll.visibleLines.slice(0, bodyRows).map((line, row) => (
                                <Box height={1} key={row} overflow="hidden" width={panelWidth}>
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
        </Box>
    );
}
