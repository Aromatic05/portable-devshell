#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FilesystemCapability {
    WorkspaceRead,
    WorkspaceWrite,
    AbsoluteRead,
    AbsoluteWrite,
    ProcessExecute,
}
