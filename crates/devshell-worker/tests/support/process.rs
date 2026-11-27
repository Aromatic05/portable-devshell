use std::time::{Duration, Instant};

use crate::support::TestEnv;
use serde_json::{Value, json};

pub struct WorkerFixture {
    pub env: TestEnv,
    instance: &'static str,
}

impl WorkerFixture {
    pub fn start(instance: &'static str) -> Self {
        let fixture = Self {
            env: TestEnv::new(),
            instance,
        };
        fixture.env.json_command(&["start", "--instance", instance]);
        fixture
    }

    pub fn tool(&self, method: &str, input: Value) -> Value {
        let result = self.env.rpc(
            self.instance,
            "tool",
            &json!({
                "protocol": "rpc",
                "type": "request",
                "id": uuid::Uuid::new_v4().to_string(),
                "method": method,
                "message": {
                    "input": input,
                    "context": {"workspace": self.env.protocol_workspace()}
                }
            }),
        );
        assert_eq!(result["type"], "reply", "{method}: {result}");
        result["message"].clone()
    }

    pub fn tool_raw(&self, method: &str, input: Value) -> Value {
        self.env.rpc(
            self.instance,
            "tool",
            &json!({
                "protocol": "rpc",
                "type": "request",
                "id": uuid::Uuid::new_v4().to_string(),
                "method": method,
                "message": {
                    "input": input,
                    "context": {"workspace": self.env.protocol_workspace()}
                }
            }),
        )
    }

    pub fn wait_task(&self, task: &str, cursor: Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut cursor = cursor.as_str().map(str::to_owned);
        let mut stdout = String::new();
        let mut stderr = String::new();
        loop {
            let mut input = json!({
                "task": task, "waitMs": 500,
            });
            if let Some(ref c) = cursor {
                input["cursor"] = json!(c);
            }
            let mut result = self.tool("task_input", input);
            stdout.push_str(result["stdout"].as_str().unwrap());
            stderr.push_str(result["stderr"].as_str().unwrap());
            if result["termination"] != "running" {
                result["stdout"] = json!(stdout);
                result["stderr"] = json!(stderr);
                return result;
            }
            cursor = result["cursor"].as_str().map(str::to_owned);
            assert!(Instant::now() < deadline, "task did not exit: {result}");
        }
    }
}
