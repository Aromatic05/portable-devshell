use std::fmt;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct InstanceName(String);

impl InstanceName {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.is_empty() {
            return Err("instance name cannot be empty".to_string());
        }

        if !raw.contains('-') {
            return Err(format!(
                "instance name `{raw}` must contain at least one hyphen-separated segment boundary"
            ));
        }

        let segments = raw.split('-').collect::<Vec<_>>();
        if segments.len() < 2 {
            return Err(format!(
                "instance name `{raw}` must contain at least two alphanumeric segments"
            ));
        }

        for segment in segments {
            if segment.is_empty() {
                return Err(format!(
                    "instance name `{raw}` must use single hyphen-separated alphanumeric segments"
                ));
            }

            if !segment.chars().all(|value| value.is_ascii_alphanumeric()) {
                return Err(format!(
                    "instance name `{raw}` must use only ASCII letters and digits in each segment"
                ));
            }
        }

        Ok(Self(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for InstanceName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}
