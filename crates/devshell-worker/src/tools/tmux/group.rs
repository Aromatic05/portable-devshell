use crate::tools::ToolName;

pub fn tmux_send_name() -> ToolName {
    ToolName::parse("tmux_send").expect("valid tmux tool name")
}

pub fn tmux_capture_name() -> ToolName {
    ToolName::parse("tmux_capture").expect("valid tmux tool name")
}

pub fn tmux_inspect_name() -> ToolName {
    ToolName::parse("tmux_inspect").expect("valid tmux tool name")
}

pub fn tmux_list_name() -> ToolName {
    ToolName::parse("tmux_list").expect("valid tmux tool name")
}

pub fn tmux_create_name() -> ToolName {
    ToolName::parse("tmux_create").expect("valid tmux tool name")
}

pub fn tmux_close_name() -> ToolName {
    ToolName::parse("tmux_close").expect("valid tmux tool name")
}
