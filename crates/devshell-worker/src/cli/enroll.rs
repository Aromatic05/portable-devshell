use crate::cli::EnrollArgs;
use crate::host::lifecycle::enroll::{self, EnrollOptions};

pub fn run(args: EnrollArgs) -> Result<String, String> {
    enroll::run(EnrollOptions {
        controller: args.controller,
        device_code: args.device_code,
    })
}
