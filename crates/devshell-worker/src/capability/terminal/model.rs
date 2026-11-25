use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenInput {
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub workspace: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachInput {
    pub terminal_id: String,
    pub generation: u64,
    pub from_seq: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub restore: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandInput {
    pub terminal_id: String,
    pub generation: u64,
    pub version: u64,
    pub client_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    #[serde(flatten)]
    pub identity: TerminalCommandInput,
    pub data: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    #[serde(flatten)]
    pub identity: TerminalCommandInput,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    pub terminal_id: String,
    pub generation: u64,
    pub version: u64,
    pub cols: u16,
    pub rows: u16,
    pub latest_seq: u64,
    pub state: String,
    pub created_at_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFrame {
    pub seq: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: i32,
    pub signal: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub session: TerminalDescriptor,
    pub replay: Vec<TerminalOutputFrame>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<TerminalRestore>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<TerminalExit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRestore {
    pub seq: u64,
    pub data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlInput {
    pub terminal_id: String,
    pub generation: u64,
    pub controller: Option<String>,
    #[serde(default)]
    pub renew: bool,
}
