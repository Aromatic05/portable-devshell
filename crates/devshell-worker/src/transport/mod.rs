use crate::instance::InstanceName;

pub mod frame;
pub mod reverse;
pub mod service;
pub mod socket;

pub fn run(instance: &str) -> Result<String, String> {
    let _ = InstanceName::parse(instance)?;
    service::serve_stdio()?;
    Ok(String::new())
}
