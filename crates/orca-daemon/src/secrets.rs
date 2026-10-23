//! Secret managers for workspace `.env` files. Each provider gives a link
//! (or hint) for filling a value in by hand, says whether its CLI is ready
//! on this machine, and fetches a value through that CLI. Values are
//! decrypted on this machine with the developer's own credentials and only
//! ever written to the project's `.env`.

use std::time::Duration;

use anyhow::{Context, Result};
use orca_core::workspace::{SecretProviders, SecretRef};
use serde::Serialize;
use tokio::process::Command;

/// What the GUI and AI tools are told about one secret.
#[derive(Debug, Clone, Serialize)]
pub struct SecretInfo {
    pub name: String,
    pub provider: &'static str,
    pub reference: String,
    /// A page to open to see the value (Passbolt), when the provider has one.
    pub link: Option<String>,
    /// Whether the project's `.env` already has a value for it.
    pub filled: bool,
}

/// The providers' CLIs on this machine, by provider name.
#[derive(Debug, Clone, Serialize, Default)]
pub struct CliStatus {
    pub passbolt: bool,
    #[serde(rename = "1password")]
    pub onepassword: bool,
}

const PASSBOLT_BINARIES: &[&str] = &["passbolt", "go-passbolt-cli"];

fn find(program: &str) -> Option<std::path::PathBuf> {
    let path = crate::dev::ops::cli_path();
    std::env::split_paths(&std::ffi::OsString::from(path)).find_map(|d| {
        let p = d.join(program);
        let exe = d.join(format!("{program}.exe"));
        [p, exe].into_iter().find(|f| f.is_file())
    })
}

pub fn cli_status() -> CliStatus {
    CliStatus {
        passbolt: PASSBOLT_BINARIES.iter().any(|b| find(b).is_some()),
        onepassword: find("op").is_some(),
    }
}

pub fn link(r: &SecretRef, providers: &SecretProviders) -> Option<String> {
    match r {
        SecretRef::Passbolt(id) => providers.passbolt.as_ref().map(|p| p.link(id)),
        // 1Password references open no web page; the reference itself is the hint.
        SecretRef::OnePassword(_) => None,
    }
}

/// Fetch one value with the provider's CLI. Never prompts: a CLI that
/// needs a passphrase or sign-in first fails, and the developer fills the
/// value in by hand instead.
pub async fn fetch(r: &SecretRef, providers: &SecretProviders) -> Result<String> {
    let (program, args): (std::path::PathBuf, Vec<String>) = match r {
        SecretRef::Passbolt(id) => {
            let bin = PASSBOLT_BINARIES
                .iter()
                .find_map(|b| find(b))
                .context("the Passbolt CLI (go-passbolt-cli) isn't installed")?;
            (
                bin,
                vec!["get".into(), "resource".into(), "--id".into(), id.clone(), "-j".into()],
            )
        }
        SecretRef::OnePassword(reference) => {
            let bin = find("op").context("the 1Password CLI (op) isn't installed")?;
            let mut args = vec!["read".into(), "--no-newline".into(), reference.clone()];
            if let Some(account) = providers.onepassword.as_ref().and_then(|o| o.account.clone()) {
                args.extend(["--account".into(), account]);
            }
            (bin, args)
        }
    };
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(&program)
            .args(&args)
            .env("PATH", crate::dev::ops::cli_path())
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .context("the CLI didn't answer within 30 seconds")??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("{}", err.lines().last().unwrap_or("failed").trim());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    match r {
        SecretRef::Passbolt(_) => passbolt_password(&stdout),
        SecretRef::OnePassword(_) => Ok(stdout),
    }
}

/// The password in `passbolt get resource --json` output.
fn passbolt_password(json: &str) -> Result<String> {
    let v: serde_json::Value = serde_json::from_str(json).context("unexpected output from the Passbolt CLI")?;
    ["password", "Password", "secret", "Secret"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|p| p.as_str()))
        .map(str::to_string)
        .context("the Passbolt CLI returned no password")
}

#[cfg(test)]
mod tests {
    #[test]
    fn passbolt_json_password() {
        assert_eq!(
            super::passbolt_password(r#"{"name":"db","password":"s3cret"}"#).unwrap(),
            "s3cret"
        );
        assert!(super::passbolt_password(r#"{"name":"db"}"#).is_err());
    }
}
