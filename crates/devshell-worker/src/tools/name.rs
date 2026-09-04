use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ToolName {
    group: String,
    operation: String,
}

impl ToolName {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.bytes().filter(|value| *value == b'_').count() != 1 {
            return Err(format!(
                "tool method `{raw}` must contain exactly one `_` separator"
            ));
        }
        let Some((group, operation)) = raw.split_once('_') else {
            return Err(format!("tool method `{raw}` must use group_operation form"));
        };

        if group.is_empty() || operation.is_empty() {
            return Err(format!(
                "tool method `{raw}` must use non-empty group and operation"
            ));
        }

        if !group
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            return Err(format!(
                "tool group `{group}` must use lowercase ASCII letters or digits"
            ));
        }

        if !operation
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            return Err(format!(
                "tool operation `{operation}` must use lowercase ASCII letters or digits"
            ));
        }

        Ok(Self {
            group: group.to_string(),
            operation: operation.to_string(),
        })
    }

    pub fn group(&self) -> &str {
        &self.group
    }

    pub fn as_str(&self) -> String {
        format!("{}_{}", self.group, self.operation)
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::ToolName;

    #[test]
    fn tool_name_requires_exactly_one_namespace_separator() {
        assert_eq!(ToolName::parse("bash_run").unwrap().group(), "bash");
        assert!(ToolName::parse("bash").is_err());
        assert!(ToolName::parse("bash_run_extra").is_err());
    }
}
