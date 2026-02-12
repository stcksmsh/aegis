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
