mod paths;
mod platform;

pub use paths::EndpointPaths;
pub use platform::{LocalIpcListener, LocalIpcStream, endpoint_may_exist};
