import { Box, Text } from "ink";
import type { TuiTerminalTab } from "../state/route/Model.js";

export const tuiTerminalTabs: readonly TuiTerminalTab[] = [
    "instances",
    "sessions",
];
export function tuiTerminalTabLabel(tab: TuiTerminalTab): string {
    return tab === "instances" ? "Instances" : "Sessions";
}
export function nextTuiTerminalTab(tab: TuiTerminalTab): TuiTerminalTab {
    return tab === "instances" ? "sessions" : "instances";
}

export interface TuiComponentTerminalTabsProps {
    activeTab: TuiTerminalTab;
    focused: boolean;
}

export function TuiComponentTerminalTabs(props: TuiComponentTerminalTabsProps) {
    return (
        <Box>
            <Text bold color={props.focused ? "cyan" : undefined}>
                {tuiTerminalTabs
                    .map((tab) =>
                        tab === props.activeTab
                            ? `[${tuiTerminalTabLabel(tab)}]`
                            : ` ${tuiTerminalTabLabel(tab)} `,
                    )
                    .join(" ")}
                {"  · Ctrl+T switch"}
            </Text>
        </Box>
    );
}
