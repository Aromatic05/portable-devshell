pub const TEST_TEMP_NAMESPACE: &str = "devshell-test";

pub fn test_temp_namespace() -> std::path::PathBuf {
    std::env::temp_dir().join(TEST_TEMP_NAMESPACE)
}

pub fn temp_dir() -> tempfile::TempDir {
    let namespace = test_temp_namespace();
    std::fs::create_dir_all(&namespace).expect("create devshell-test namespace");
    tempfile::Builder::new()
        .prefix("test-")
        .tempdir_in(&namespace)
        .expect("create isolated test temp directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_dirs_live_under_the_devshell_test_namespace() {
        let directory = temp_dir();
        let namespace = test_temp_namespace();
        assert!(directory.path().starts_with(&namespace), "{:?}", directory.path());
        assert!(directory.path().is_dir());
    }

    #[test]
    fn concurrent_temp_dirs_never_collide() {
        let directories: Vec<tempfile::TempDir> = (0..16).map(|_| temp_dir()).collect();
        let mut paths: Vec<_> = directories.iter().map(|d| d.path().to_path_buf()).collect();
        let unique = paths.iter().cloned().collect::<std::collections::HashSet<_>>().len();
        assert_eq!(unique, paths.len());
        paths.sort();
        for window in paths.windows(2) {
            assert_ne!(window[0], window[1]);
        }
    }

    #[test]
    fn dropping_one_temp_dir_leaves_siblings_intact() {
        let first = temp_dir();
        let second = temp_dir();
        let first_path = first.path().to_path_buf();
        let second_path = second.path().to_path_buf();
        drop(first);
        assert!(!first_path.exists());
        assert!(second_path.is_dir());
    }
}
