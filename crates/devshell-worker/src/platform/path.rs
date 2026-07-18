use std::path::Path;

pub fn protocol_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        return normalize_windows_verbatim_path(&value);
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_verbatim_path(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::normalize_windows_verbatim_path;

    #[test]
    fn strips_windows_drive_verbatim_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\C:\workspace\project"),
            r"C:\workspace\project"
        );
    }

    #[test]
    fn converts_windows_unc_verbatim_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\UNC\server\share\project"),
            r"\\server\share\project"
        );
    }

    #[test]
    fn preserves_normal_paths() {
        assert_eq!(
            normalize_windows_verbatim_path(r"C:\workspace\project"),
            r"C:\workspace\project"
        );
    }
}
