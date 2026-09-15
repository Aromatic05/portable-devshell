pub mod model;
pub mod process;
pub mod run;

use crate::tool::ToolName;

pub fn bash_run_name() -> ToolName {
    ToolName::parse("bash_run").expect("hard-coded bash_run name must be valid")
}
