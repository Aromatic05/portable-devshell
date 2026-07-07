use crate::tools::ToolName;

pub fn bash_run_name() -> ToolName {
    ToolName::parse("bash_run").expect("hard-coded bash_run name must be valid")
}
