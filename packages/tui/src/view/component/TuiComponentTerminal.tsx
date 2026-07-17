import { useEffect, useSyncExternalStore } from "react";
import { Box, Text } from "ink";

import type { TuiTerminalSnapshot } from "../../runtime/terminal/TuiTerminalModel.js";

export interface TuiTerminalRenderSource {
    getSnapshot(): TuiTerminalSnapshot;
    subscribe(listener: () => void): () => void;
}

export interface TuiComponentTerminalProps {
    columns: number;
    focused: boolean;
    instance?: string;
    onOpen(instance: string | undefined, columns: number, rows: number): Promise<void>;
    rows: number;
    source: TuiTerminalRenderSource;
}

export function TuiComponentTerminal(props: TuiComponentTerminalProps) {
    const snapshot = useSyncExternalStore(
        (listener) => props.source.subscribe(listener),
        () => props.source.getSnapshot(),
        () => props.source.getSnapshot()
    );

    useEffect(() => {
        void props.onOpen(props.instance, props.columns, props.rows);
    }, [props.columns, props.instance, props.onOpen, props.rows]);

    const status = snapshot.error ?? snapshot.message ?? `${snapshot.status}${snapshot.exitCode === undefined ? "" : ` (${snapshot.exitCode})`}`;
    return (
        <Box flexDirection="column" height={props.rows + 1} overflow="hidden">
            <Text bold color={props.focused ? "cyan" : undefined}>
                {`terminal · ${props.instance ?? "no instance"} · ${status} · ${props.focused ? "Ctrl+] sidebar" : "→/Tab focus"}`}
            </Text>
            {snapshot.lines.slice(0, props.rows).map((line, row) => (
                <Box height={1} key={row} overflow="hidden" width={props.columns}>
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
        </Box>
    );
}
