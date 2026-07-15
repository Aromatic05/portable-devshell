use std::env;
use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub distribution: DistributionInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<String>,
}

pub fn detect_environment() -> EnvironmentInfo {
    EnvironmentInfo {
        distribution: detect_distribution(),
        package_manager: detect_package_manager(),
    }
}

fn detect_distribution() -> DistributionInfo {
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = fs::read_to_string("/etc/os-release")
            && let Some(distribution) = parse_os_release(&contents)
        {
            return distribution;
        }
        DistributionInfo {
            id: "linux".to_string(),
            name: "Linux".to_string(),
            version: None,
        }
    }

    #[cfg(target_os = "macos")]
    {
        DistributionInfo {
            id: "macos".to_string(),
            name: "macOS".to_string(),
            version: None,
        }
    }

    #[cfg(target_os = "windows")]
    {
        DistributionInfo {
            id: "windows".to_string(),
            name: "Windows".to_string(),
            version: None,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        DistributionInfo {
            id: env::consts::OS.to_string(),
            name: env::consts::OS.to_string(),
            version: None,
        }
    }
}

fn parse_os_release(contents: &str) -> Option<DistributionInfo> {
    let mut id = None;
    let mut name = None;
    let mut version = None;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unquote(value.trim());
        match key {
            "ID" if !value.is_empty() => id = Some(value),
            "PRETTY_NAME" if !value.is_empty() => name = Some(value),
            "NAME" if !value.is_empty() && name.is_none() => name = Some(value),
            "VERSION_ID" if !value.is_empty() => version = Some(value),
            _ => {}
        }
    }

    let id = id?;
    Some(DistributionInfo {
        name: name.unwrap_or_else(|| id.clone()),
        version: version.or_else(|| (id == "arch").then(|| "rolling".to_string())),
        id,
    })
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
        }
    }
    value.to_string()
}

fn detect_package_manager() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["winget", "choco", "scoop"]
    } else if cfg!(target_os = "macos") {
        &["brew", "port", "nix"]
    } else {
        &[
            "apt-get", "dnf", "yum", "pacman", "apk", "zypper", "emerge", "nix",
        ]
    };

    candidates
        .iter()
        .find(|candidate| executable_in_path(candidate))
        .map(|candidate| normalize_package_manager(candidate).to_string())
}

fn executable_in_path(name: &str) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&path).any(|directory| executable_exists(&directory, name))
}

fn executable_exists(directory: &Path, name: &str) -> bool {
    if directory.join(name).is_file() {
        return true;
    }
    cfg!(target_os = "windows") && directory.join(format!("{name}.exe")).is_file()
}

fn normalize_package_manager(name: &str) -> &str {
    if name == "apt-get" { "apt" } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_distribution() {
        let distribution = parse_os_release(
            "ID=ubuntu\nNAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\nVERSION_ID=\"24.04\"\n",
        )
        .unwrap();
        assert_eq!(distribution.id, "ubuntu");
        assert_eq!(distribution.name, "Ubuntu 24.04 LTS");
        assert_eq!(distribution.version.as_deref(), Some("24.04"));
    }

    #[test]
    fn reports_arch_as_rolling_when_version_is_absent() {
        let distribution = parse_os_release("ID=arch\nPRETTY_NAME=\"Arch Linux\"\n").unwrap();
        assert_eq!(distribution.version.as_deref(), Some("rolling"));
    }
}
