use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub enabled: bool,
    pub keep_last: u32,
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
    pub keep_yearly: u32,
    pub min_snapshots: u32,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            keep_last: 0,
            keep_daily: 0,
            keep_weekly: 0,
            keep_monthly: 0,
            keep_yearly: 0,
            min_snapshots: 3,
        }
    }
}

impl RetentionPolicy {
    pub fn to_forget_args(&self) -> Vec<String> {
        if !self.enabled {
            return Vec::new();
        }
        let mut args = Vec::new();
        let keep_last = self.keep_last.max(self.min_snapshots);
        if keep_last > 0 {
            args.push("--keep-last".to_string());
            args.push(keep_last.to_string());
        }
        if self.keep_daily > 0 {
            args.push("--keep-daily".to_string());
            args.push(self.keep_daily.to_string());
        }
        if self.keep_weekly > 0 {
            args.push("--keep-weekly".to_string());
            args.push(self.keep_weekly.to_string());
        }
        if self.keep_monthly > 0 {
            args.push("--keep-monthly".to_string());
            args.push(self.keep_monthly.to_string());
        }
        if self.keep_yearly > 0 {
            args.push("--keep-yearly".to_string());
            args.push(self.keep_yearly.to_string());
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_forget_args_disabled_returns_empty() {
        let p = RetentionPolicy {
            enabled: false,
            keep_last: 5,
            keep_daily: 7,
            ..Default::default()
        };
        assert!(p.to_forget_args().is_empty());
    }

    #[test]
    fn to_forget_args_keep_last_and_min_snapshots() {
        let p = RetentionPolicy {
            enabled: true,
            keep_last: 2,
            min_snapshots: 5,
            ..Default::default()
        };
        let args = p.to_forget_args();
        assert!(args.contains(&"--keep-last".to_string()));
        assert_eq!(
            args[args.iter().position(|a| a == "--keep-last").unwrap() + 1],
            "5"
        );
    }

    #[test]
    fn to_forget_args_keep_daily_weekly_monthly_yearly() {
        let p = RetentionPolicy {
            enabled: true,
            keep_last: 1,
            keep_daily: 7,
            keep_weekly: 4,
            keep_monthly: 12,
            keep_yearly: 2,
            min_snapshots: 0,
        };
        let args = p.to_forget_args();
        assert_eq!(
            args,
            &[
                "--keep-last",
                "1",
                "--keep-daily",
                "7",
                "--keep-weekly",
                "4",
                "--keep-monthly",
                "12",
                "--keep-yearly",
                "2",
            ]
            .map(String::from)
        );
    }

    #[test]
    fn to_forget_args_only_keep_last_when_others_zero() {
        let p = RetentionPolicy {
            enabled: true,
            keep_last: 3,
            keep_daily: 0,
            keep_weekly: 0,
            keep_monthly: 0,
            keep_yearly: 0,
            min_snapshots: 2,
        };
        let args = p.to_forget_args();
        assert_eq!(args, &["--keep-last".to_string(), "3".to_string()]);
    }
}
