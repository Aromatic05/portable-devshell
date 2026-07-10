use crate::cli::InstanceArgs;
use crate::instance::InstanceName;
use crate::storage::InstancePaths;

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let instance_paths = InstancePaths::resolve(&instance)?;
    std::fs::read_to_string(&instance_paths.log_file).map_err(|error| {
        format!(
            "failed to read {}: {error}",
            instance_paths.log_file.display()
        )
    })
}
