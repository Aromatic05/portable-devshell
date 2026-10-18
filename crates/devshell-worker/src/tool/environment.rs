use std::collections::BTreeMap;

use super::ToolCall;

/// Prepared process environment, independent of how the Worker produced it.
#[derive(Clone, Debug)]
pub struct ToolCommandEnvironment {
    values: Vec<(&'static str, String)>,
    unset: Vec<&'static str>,
}

impl ToolCommandEnvironment {
    pub fn new(values: Vec<(&'static str, String)>, unset: Vec<&'static str>) -> Self {
        Self { values, unset }
    }

    pub fn inject(&self, env: &mut BTreeMap<String, Option<String>>) {
        for (key, value) in &self.values {
            env.insert((*key).to_string(), Some(value.clone()));
        }
        for key in &self.unset {
            env.insert((*key).to_string(), None);
        }
    }

    pub fn pairs(&self) -> Vec<(&'static str, &str)> {
        self.values
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect()
    }
}

/// Execution environment capability provided by the Worker composition root.
pub trait ToolCommandEnvironmentProvider: Send + Sync {
    fn environment(
        &self,
        call: &ToolCall,
        task_id: Option<&str>,
        requested_path: Option<&str>,
    ) -> Option<ToolCommandEnvironment>;
}
