use crate::tools::ToolName;

pub fn tmux_run_name() -> ToolName {
    ToolName::parse("tmux_run").expect("valid tmux tool name")
}

pub fn tmux_input_name() -> ToolName {
    ToolName::parse("tmux_input").expect("valid tmux tool name")
}

pub fn tmux_read_name() -> ToolName {
    ToolName::parse("tmux_read").expect("valid tmux tool name")
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
