import { Box, Text } from "ink";

import type { TuiTerminalTab } from "../../state/route/TuiRoute.js";
import { tuiTerminalTabs, tuiTerminalTabLabel } from "../../view/page/terminal/TuiTmuxPaneTerminalModel.js";

export interface TuiComponentTerminalTabsProps {
    activeTab: TuiTerminalTab;
    focused: boolean;
}

export function TuiComponentTerminalTabs(props: TuiComponentTerminalTabsProps) {
    return (
        <Box>
            <Text bold color={props.focused ? "cyan" : undefined}>
                {tuiTerminalTabs
                    .map((tab) => (tab === props.activeTab ? `[${tuiTerminalTabLabel(tab)}]` : ` ${tuiTerminalTabLabel(tab)} `))
                    .join(" ")}
                {"  · Ctrl+T switch"}
            </Text>
        </Box>
    );
}
