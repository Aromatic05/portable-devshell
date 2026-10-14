use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

pub const CONFIG_ENV: &str = "DEVSHELL_WORKER_EXECUTION_CONFIG";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionConfig {
    #[serde(default)]
    pub environment: Vec<Provider>,
    pub sandbox: Option<Sandbox>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub order: i64,
    pub name: String,
    #[serde(default)]
    pub content: serde_json::Value,
    pub driver: Option<Driver>,
    #[serde(default = "process_phase")]
    pub phase: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sandbox {
    pub name: String,
    #[serde(default)]
    pub content: serde_json::Value,
    pub driver: Option<Driver>,
    #[serde(default = "process_phase")]
    pub phase: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Driver {
    pub name: String,
    pub version: u32,
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    #[serde(rename = "options")]
    pub _options: serde_json::Value,
}

fn process_phase() -> String {
    "process".into()
}

impl ExecutionConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(raw) = std::env::var_os(CONFIG_ENV) else {
            return Ok(None);
        };
        let raw = raw
            .into_string()
            .map_err(|_| format!("{CONFIG_ENV} is not UTF-8"))?;
        let config: Self =
            serde_json::from_str(&raw).map_err(|e| format!("invalid {CONFIG_ENV}: {e}"))?;
        config.validate()?;
        Ok(Some(config))
    }

    pub fn validate(&self) -> Result<(), String> {
        let mut last = None;
        for provider in &self.environment {
            if last.is_some_and(|value| provider.order <= value) {
                return Err("execution environment order must be strictly increasing".into());
            }
            last = Some(provider.order);
            if !matches!(provider.phase.as_str(), "daemon" | "process") {
                return Err("invalid environment provider phase".into());
            }
            if let Some(driver) = &provider.driver {
                validate_driver(driver, &provider.name)?;
            }
        }
        if let Some(sandbox) = &self.sandbox {
            if !matches!(sandbox.phase.as_str(), "daemon" | "process") {
                return Err("invalid sandbox phase".into());
            }
            if let Some(driver) = &sandbox.driver {
                validate_driver(driver, &sandbox.name)?;
            }
        }
        Ok(())
    }

    pub fn environment(&self, cwd: &Path) -> Result<BTreeMap<String, Option<String>>, String> {
        self.environment_for(cwd, "process")
    }

    /// Each provider sees the preceding provider's result. A failed optional hook
    /// has no observable effect on the environment prepared for its successor.
    pub fn environment_for(
        &self,
        cwd: &Path,
        phase: &str,
    ) -> Result<BTreeMap<String, Option<String>>, String> {
        let mut env = std::env::vars()
            .map(|(k, v)| (k, Some(v)))
            .collect::<BTreeMap<_, _>>();
        for provider in self.environment.iter().filter(|p| p.phase == phase) {
            let mut prepared = env.clone();
            let result = match (&provider.driver, provider.name.as_str()) {
                (Some(driver), _) => apply_json_driver(&mut prepared, cwd, driver),
                (None, "variables") => apply_variables(&mut prepared, &provider.content),
                (None, "direnv") => apply_direnv(&mut prepared, cwd),
                _ => Err(format!("unknown environment provider `{}`", provider.name)),
            };
            match result {
                Ok(()) => env = prepared,
                Err(error) => {
                    let required = provider
                        .content
                        .get("required")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if required {
                        return Err(format!(
                            "required execution provider {} failed: {error}",
                            provider.name
                        ));
                    }
                    eprintln!(
                        "warning: execution provider {} skipped: {error}",
                        provider.name
                    );
                }
            }
        }
        Ok(env)
    }
}

fn validate_driver(driver: &Driver, selected_name: &str) -> Result<(), String> {
    if driver.name != selected_name || driver.version != 1 {
        return Err(format!("invalid execution driver for `{selected_name}`"));
    }
    if driver
        .executable
        .as_ref()
        .is_some_and(|value| value.is_empty())
    {
        return Err(format!(
            "execution driver for `{selected_name}` has no executable"
        ));
    }
    Ok(())
}

fn apply_variables(
    env: &mut BTreeMap<String, Option<String>>,
    content: &serde_json::Value,
) -> Result<(), String> {
    if let Some(set) = content.get("set") {
        let set = set.as_object().ok_or("variables.set must be an object")?;
        for (key, value) in set {
            let value = value.as_str().ok_or("variables values must be strings")?;
            env.insert(key.clone(), Some(value.to_string()));
        }
    }
    if let Some(unset) = content.get("unset") {
        let unset = unset.as_array().ok_or("variables.unset must be an array")?;
        for key in unset {
            env.insert(
                key.as_str()
                    .ok_or("variables.unset entries must be strings")?
                    .into(),
                None,
            );
        }
    }
    Ok(())
}

fn apply_direnv(env: &mut BTreeMap<String, Option<String>>, cwd: &Path) -> Result<(), String> {
    apply_json_driver_command(env, cwd, "direnv", &["export".into(), "json".into()])
}

fn apply_json_driver(
    env: &mut BTreeMap<String, Option<String>>,
    cwd: &Path,
    driver: &Driver,
) -> Result<(), String> {
    let executable = driver
        .executable
        .as_ref()
        .ok_or("execution environment driver has no executable")?;
    apply_json_driver_command(env, cwd, executable, &driver.args)
}

fn apply_json_driver_command(
    env: &mut BTreeMap<String, Option<String>>,
    cwd: &Path,
    executable: &str,
    args: &[String],
) -> Result<(), String> {
    let output = Command::new(executable)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().filter_map(|(k, v)| v.as_ref().map(|v| (k, v))))
        .output()
        .map_err(|e| format!("could not launch environment driver `{executable}`: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let patch: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid environment driver output: {e}"))?;
    let object = patch
        .as_object()
        .ok_or("environment driver output must be a JSON object")?;
    for (key, value) in object {
        match value {
            serde_json::Value::String(value) => {
                env.insert(key.clone(), Some(value.clone()));
            }
            serde_json::Value::Null => {
                env.insert(key.clone(), None);
            }
            _ => return Err(format!("direnv value for {key} is not a string or null")),
        }
    }
    Ok(())
}

pub fn process_sandbox(
    config: Option<&ExecutionConfig>,
) -> Result<Option<(String, Vec<String>)>, String> {
    sandbox_for(config, "process")
}

pub fn daemon_sandbox(
    config: Option<&ExecutionConfig>,
) -> Result<Option<(String, Vec<String>)>, String> {
    sandbox_for(config, "daemon")
}

fn sandbox_for(
    config: Option<&ExecutionConfig>,
    phase: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    let Some(sandbox) = config
        .and_then(|c| c.sandbox.as_ref())
        .filter(|s| s.phase == phase)
    else {
        return Ok(None);
    };
    let (executable, mut args) = match &sandbox.driver {
        Some(driver) => (
            driver
                .executable
                .clone()
                .ok_or("sandbox driver has no executable")?,
            driver.args.clone(),
        ),
        None if sandbox.name == "bubblewrap" => ("bwrap".to_owned(), Vec::new()),
        None => return Err(format!("unsupported {phase} sandbox `{}`", sandbox.name)),
    };
    let content_args = sandbox
        .content
        .get("args")
        .and_then(serde_json::Value::as_array)
        .ok_or("sandbox content.args must be an array")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("bubblewrap args must be strings".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    args.extend(content_args);
    Ok(Some((executable, args)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_config_and_rejects_non_increasing_order() {
        let config: ExecutionConfig = serde_json::from_value(serde_json::json!({"environment":[{"order":1,"name":"variables","content":{}},{"order":2,"name":"direnv","content":{}}]})).unwrap();
        assert_eq!(config.environment[0].phase, "process");
        config.validate().unwrap();
        let duplicate: ExecutionConfig = serde_json::from_value(
            serde_json::json!({"environment":[{"order":2,"name":"x"},{"order":2,"name":"y"}]}),
        )
        .unwrap();
        assert!(duplicate.validate().is_err());
    }
    #[test]
    fn variables_provider_sets_and_removes() {
        let mut env = BTreeMap::from([("REMOVE".into(), Some("old".into()))]);
        apply_variables(
            &mut env,
            &serde_json::json!({"set":{"ADD":"new"},"unset":["REMOVE"]}),
        )
        .unwrap();
        assert_eq!(env["ADD"].as_deref(), Some("new"));
        assert_eq!(env["REMOVE"], None);
    }
}
