use super::scope::*;
use crate::capability::process::client::ProcessHostClient;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::tool::contract::catalog_entry;
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};
use crate::transport::endpoint::channel::EndpointPaths;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectParams {
    terminal: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum ManageParams {
    List,
    Close {
        id: String,
    },
    Create {
        cwd: Option<String>,
        shell: Option<String>,
    },
}

struct TerminalTool {
    name: ToolName,
    instance: InstanceName,
}

impl ToolHandler for TerminalTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        match self.name.as_str().as_str() {
            "task_inspect" => catalog_entry::<InspectParams, Value>(
                &self.name,
                "Inspect the current terminal screen without consuming task output.",
                [ToolCapability::Read],
            ),
            _ => catalog_entry::<ManageParams, Value>(
                &self.name,
                "List, create or close process terminals in the current execution scope.",
                [ToolCapability::Execute],
            ),
        }
    }
    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
        call.check_cancelled()?;
        match self.name.as_str().as_str() {
            "task_inspect" => {
                require_read(&call)?;
                let params: InspectParams = call.parse_params()?;
                let client = connect(&self.instance)?;
                require(&client, &call, &params.terminal)?;
                rpc(
                    &client,
                    "process.v1.inspect",
                    json!({"id": params.terminal}),
                )
            }
            _ => {
                let params: ManageParams = call.parse_params()?;
                match params {
                    ManageParams::List => {
                        require_read(&call)?;
                        let paths = InstancePaths::resolve(&self.instance).map_err(error)?;
                        let endpoints = EndpointPaths::resolve(&self.instance).map_err(error)?;
                        let Some(client) =
                            ProcessHostClient::connect(&self.instance, &paths, &endpoints)
                                .map_err(error)?
                        else {
                            return Ok(json!({"tasks": []}));
                        };
                        let mut tasks = Vec::new();
                        for descriptor in client
                            .list()
                            .map_err(error)?
                            .as_array()
                            .ok_or_else(|| error("invalid resource list"))?
                        {
                            if scoped(&call, descriptor)? {
                                tasks.push(descriptor.clone());
                            }
                        }
                        Ok(json!({"tasks": tasks}))
                    }
                    ManageParams::Close { id } => {
                        require_execute(&call)?;
                        let client = connect(&self.instance)?;
                        require(&client, &call, &id)?;
                        rpc(&client, "process.v1.kill", json!({"id": id}))
                    }
                    ManageParams::Create { cwd, shell } => {
                        require_execute(&call)?;
                        if call.stateless && cwd.is_none() {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "absolute cwd is required in stateless mode",
                            ));
                        }
                        let client = ProcessHostClient::ensure(&self.instance).map_err(error)?;
                        #[cfg(unix)]
                        let default_shell = "exec bash --noprofile --norc -i";
                        #[cfg(windows)]
                        let default_shell = "powershell.exe -NoLogo -NoProfile";
                        rpc(
                            &client,
                            "process.v1.spawn",
                            json!({
                                "command": shell.unwrap_or_else(|| default_shell.into()),
                                "cwd": cwd.unwrap_or_else(|| "./".into()),
                                "workspace": (!call.stateless).then_some(&call.workspace),
                                "tty": true, "keepStdin": true
                            }),
                        )
                    }
                }
            }
        }
    }
}

pub(crate) fn register_tools(
    registry: &mut ToolRegistry,
    instance: &InstanceName,
) -> Result<(), ToolError> {
    for name in ["task_inspect", "task_manage"] {
        registry.register(Arc::new(TerminalTool {
            name: ToolName::parse(name).map_err(error)?,
            instance: instance.clone(),
        }))?;
    }
    Ok(())
}
