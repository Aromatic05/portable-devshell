mod endpoint;
mod platform;

pub use endpoint::SocketPaths;
pub use platform::{LocalIpcListener, LocalIpcStream, endpoint_may_exist};
