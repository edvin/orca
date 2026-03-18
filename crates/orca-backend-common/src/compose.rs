use std::process::Stdio;

use tokio::process::Command;
use orca_core::compose::{ComposeOutput, ComposeRunner};
use orca_core::runtime::RuntimeKind;

use crate::BollardRuntime;

impl ComposeRunner for BollardRuntime {
    async fn compose_up(
        &self,
        working_dir: &str,
        config_file: Option<&str>,
    ) -> anyhow::Result<ComposeOutput> {
        run_compose(self, working_dir, config_file, &["up", "-d"]).await
    }

    async fn compose_down(
        &self,
        working_dir: &str,
        config_file: Option<&str>,
    ) -> anyhow::Result<ComposeOutput> {
        run_compose(self, working_dir, config_file, &["down"]).await
    }

    async fn compose_restart(
        &self,
        working_dir: &str,
        config_file: Option<&str>,
    ) -> anyhow::Result<ComposeOutput> {
        run_compose(self, working_dir, config_file, &["restart"]).await
    }

    async fn compose_pull(
        &self,
        working_dir: &str,
        config_file: Option<&str>,
    ) -> anyhow::Result<ComposeOutput> {
        run_compose(self, working_dir, config_file, &["pull"]).await
    }
}

async fn run_compose(
    backend: &BollardRuntime,
    working_dir: &str,
    config_file: Option<&str>,
    args: &[&str],
) -> anyhow::Result<ComposeOutput> {
    let runtime = backend.detect_runtime().await;

    let (program, base_args): (&str, Vec<&str>) = match runtime {
        RuntimeKind::Podman => ("podman", vec!["compose"]),
        RuntimeKind::Docker => ("docker", vec!["compose"]),
    };

    let mut cmd = Command::new(program);
    cmd.current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for arg in &base_args {
        cmd.arg(arg);
    }

    if let Some(file) = config_file {
        cmd.arg("-f").arg(file);
    }

    for arg in args {
        cmd.arg(arg);
    }

    tracing::info!("Running: {program} {} {}", base_args.join(" "), args.join(" "));

    let output = cmd.output().await?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        tracing::warn!(
            "Compose command exited with {exit_code}: {}",
            stderr.lines().next().unwrap_or("(no output)")
        );
    }

    Ok(ComposeOutput {
        success: output.status.success(),
        stdout,
        stderr,
        exit_code,
    })
}
