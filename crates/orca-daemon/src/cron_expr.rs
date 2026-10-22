//! Schedules use standard cron: five fields, minute first, Sunday is 0 (or
//! 7). The `cron` crate wants a seconds field first and numbers Sunday 1, so
//! expressions are translated before parsing. Six- and seven-field
//! expressions (seconds first) are passed through, as older schedules used
//! that form.

use std::str::FromStr;

/// Parse a schedule's expression.
pub fn parse(expr: &str) -> anyhow::Result<cron::Schedule> {
    let crate_expr = to_crate_syntax(expr)?;
    cron::Schedule::from_str(&crate_expr).map_err(|e| anyhow::anyhow!("not a valid cron expression ({e})"))
}

fn to_crate_syntax(expr: &str) -> anyhow::Result<String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    match fields.len() {
        5 => Ok(format!(
            "0 {} {} {} {} {}",
            fields[0],
            fields[1],
            fields[2],
            fields[3],
            day_of_week(fields[4])?
        )),
        6 | 7 => Ok(fields.join(" ")),
        n => anyhow::bail!("a cron expression has 5 fields (minute hour day month weekday), not {n}"),
    }
}

/// Standard weekday numbers (0–7, Sunday 0 or 7) to the crate's (1–7,
/// Sunday 1). Names (`MON-FRI`) and `*`/`?` pass through.
fn day_of_week(field: &str) -> anyhow::Result<String> {
    if !field.chars().any(|c| c.is_ascii_digit()) || field.chars().any(|c| c.is_ascii_alphabetic()) {
        return Ok(field.to_string());
    }
    let mut days = std::collections::BTreeSet::new();
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (
                r,
                s.parse::<u32>().map_err(|_| anyhow::anyhow!("bad step in '{part}'"))?,
            ),
            None => (part, 1),
        };
        if step == 0 {
            anyhow::bail!("bad step in '{part}'");
        }
        let (start, end) = if range == "*" {
            (0, 6)
        } else if let Some((a, b)) = range.split_once('-') {
            (num(a)?, num(b)?)
        } else {
            let n = num(range)?;
            (n, if part.contains('/') { 6 } else { n })
        };
        if start > end {
            anyhow::bail!("weekday range '{range}' runs backwards");
        }
        let mut d = start;
        while d <= end {
            days.insert(d % 7);
            d += step;
        }
    }
    Ok(days.iter().map(|d| (d + 1).to_string()).collect::<Vec<_>>().join(","))
}

fn num(s: &str) -> anyhow::Result<u32> {
    match s.parse::<u32>() {
        Ok(n) if n <= 7 => Ok(n),
        _ => anyhow::bail!("'{s}' is not a weekday (0–7, Sunday is 0 or 7)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Timelike, Weekday};

    fn next(expr: &str) -> chrono::DateTime<chrono::Utc> {
        // A Wednesday.
        let from = chrono::Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0).unwrap();
        parse(expr).unwrap().after(&from).next().unwrap()
    }

    #[test]
    fn standard_five_field_expressions() {
        let n = next("0 3 * * 0");
        assert_eq!((n.weekday(), n.hour(), n.minute()), (Weekday::Sun, 3, 0));
        assert_eq!(next("0 3 * * 7").weekday(), Weekday::Sun);
        assert_eq!(next("30 18 * * 1-5").weekday(), Weekday::Wed);
        assert_eq!(next("0 9 * * 6").weekday(), Weekday::Sat);
        assert_eq!(next("0 9 * * 5-7").weekday(), Weekday::Fri);
        assert_eq!(next("0 */6 * * *").hour(), 18);
        assert_eq!(next("0 0 1 * *").day(), 1);
        assert_eq!(next("0 3 * * MON").weekday(), Weekday::Mon);
    }

    #[test]
    fn seconds_first_expressions_still_work() {
        assert_eq!(next("0 0 3 * * Sun").weekday(), Weekday::Sun);
    }

    #[test]
    fn bad_expressions_say_why() {
        assert!(parse("0 3 * *").unwrap_err().to_string().contains("5 fields"));
        assert!(parse("0 3 * * 9").unwrap_err().to_string().contains("not a weekday"));
    }
}
