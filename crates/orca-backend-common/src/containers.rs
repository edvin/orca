use std::collections::HashMap;

use bollard::container::{
    CreateContainerOptions, KillContainerOptions, ListContainersOptions, LogsOptions,
    RemoveContainerOptions, StatsOptions, StopContainerOptions, UpdateContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::models::HostConfig;
use tokio_stream::StreamExt;

use orca_core::runtime::*;

use crate::BollardRuntime;

impl ContainerRuntime for BollardRuntime {
    fn kind(&self) -> RuntimeKind {
        // Will be overridden by detect_runtime() at startup, but default to Docker
        RuntimeKind::Docker
    }

    async fn create_container(&self, opts: ContainerCreateOpts) -> anyhow::Result<String> {
        let port_bindings: HashMap<String, Option<Vec<bollard::models::PortBinding>>> = opts
            .ports
            .iter()
            .map(|p| {
                let key = format!("{}/{}", p.container_port, p.protocol);
                let binding = bollard::models::PortBinding {
                    host_ip: p.host_ip.clone(),
                    host_port: Some(p.host_port.to_string()),
                };
                (key, Some(vec![binding]))
            })
            .collect();

        let binds: Vec<String> = opts
            .volumes
            .iter()
            .map(|v| {
                if v.read_only {
                    format!("{}:{}:ro", v.source, v.target)
                } else {
                    format!("{}:{}", v.source, v.target)
                }
            })
            .collect();

        let config = bollard::container::Config {
            image: Some(opts.image.clone()),
            cmd: if opts.command.is_empty() {
                None
            } else {
                Some(opts.command.clone())
            },
            entrypoint: opts.entrypoint.clone(),
            env: Some(
                opts.env
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect(),
            ),
            labels: Some(opts.labels.clone()),
            host_config: Some(HostConfig {
                port_bindings: Some(port_bindings),
                binds: Some(binds),
                restart_policy: opts.restart_policy.map(|p| {
                    bollard::models::RestartPolicy {
                        name: Some(match p.as_str() {
                            "always" => bollard::models::RestartPolicyNameEnum::ALWAYS,
                            "unless-stopped" => {
                                bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED
                            }
                            "on-failure" => bollard::models::RestartPolicyNameEnum::ON_FAILURE,
                            _ => bollard::models::RestartPolicyNameEnum::NO,
                        }),
                        maximum_retry_count: None,
                    }
                }),
                network_mode: opts.network.clone(),
                auto_remove: Some(opts.remove_on_exit),
                nano_cpus: opts.cpu_limit.map(|c| (c * 1_000_000_000.0) as i64),
                memory: opts.memory_limit.map(|m| m as i64),
                memory_swap: opts.memory_swap,
                device_requests: if opts.gpu {
                    Some(vec![bollard::models::DeviceRequest {
                        driver: Some("nvidia".to_string()),
                        count: Some(-1), // all GPUs
                        capabilities: Some(vec![vec!["gpu".to_string()]]),
                        ..Default::default()
                    }])
                } else {
                    None
                },
                ..Default::default()
            }),
            ..Default::default()
        };

        let create_opts = opts
            .name
            .as_ref()
            .map(|n| CreateContainerOptions { name: n.as_str(), platform: None });

        let response = self.docker.create_container(create_opts, config).await?;
        Ok(response.id)
    }

    async fn start_container(&self, id: &str) -> anyhow::Result<()> {
        self.docker
            .start_container::<String>(id, None)
            .await?;
        Ok(())
    }

    async fn stop_container(&self, id: &str, timeout_secs: u32) -> anyhow::Result<()> {
        self.docker
            .stop_container(
                id,
                Some(StopContainerOptions {
                    t: timeout_secs as i64,
                }),
            )
            .await?;
        Ok(())
    }

    async fn kill_container(&self, id: &str, signal: &str) -> anyhow::Result<()> {
        self.docker
            .kill_container(
                id,
                Some(KillContainerOptions { signal }),
            )
            .await?;
        Ok(())
    }

    async fn remove_container(&self, id: &str, force: bool) -> anyhow::Result<()> {
        self.docker
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force,
                    ..Default::default()
                }),
            )
            .await?;
        Ok(())
    }

    async fn inspect_container(&self, id: &str) -> anyhow::Result<Container> {
        let info = self.docker.inspect_container(id, None).await?;
        Ok(inspect_to_container(&info))
    }

    async fn list_containers(&self, all: bool) -> anyhow::Result<Vec<Container>> {
        let options = ListContainersOptions::<String> {
            all,
            ..Default::default()
        };
        let containers = self.docker.list_containers(Some(options)).await?;

        Ok(containers.iter().map(summary_to_container).collect())
    }

    async fn container_logs(
        &self,
        id: &str,
        follow: bool,
        tail: Option<u32>,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<String>> {
        let options = LogsOptions::<String> {
            follow,
            stdout: true,
            stderr: true,
            tail: tail
                .map(|t| t.to_string())
                .unwrap_or_else(|| "100".to_string()),
            ..Default::default()
        };

        let stream = self.docker.logs(id, Some(options));
        let (tx, rx) = tokio::sync::mpsc::channel(256);

        tokio::spawn(async move {
            tokio::pin!(stream);
            while let Some(Ok(output)) = stream.next().await {
                let line = output.to_string();
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }

    async fn container_stats(&self, id: &str) -> anyhow::Result<ContainerStats> {
        let options = StatsOptions {
            stream: false,
            one_shot: true,
        };
        let mut stream = self.docker.stats(id, Some(options));

        let stats = stream
            .next()
            .await
            .ok_or_else(|| anyhow::anyhow!("no stats returned"))??;

        let cpu_delta = stats.cpu_stats.cpu_usage.total_usage as f64
            - stats.precpu_stats.cpu_usage.total_usage as f64;
        let system_delta = stats.cpu_stats.system_cpu_usage.unwrap_or(0) as f64
            - stats.precpu_stats.system_cpu_usage.unwrap_or(0) as f64;
        let num_cpus = stats
            .cpu_stats
            .online_cpus
            .unwrap_or(1) as f64;

        let cpu_percent = if system_delta > 0.0 {
            (cpu_delta / system_delta) * num_cpus * 100.0
        } else {
            0.0
        };

        Ok(ContainerStats {
            container_id: id.to_string(),
            cpu_percent,
            memory_usage_bytes: stats.memory_stats.usage.unwrap_or(0),
            memory_limit_bytes: stats.memory_stats.limit.unwrap_or(0),
            network_rx_bytes: stats
                .networks
                .as_ref()
                .map(|n| n.values().map(|v| v.rx_bytes).sum())
                .unwrap_or(0),
            network_tx_bytes: stats
                .networks
                .as_ref()
                .map(|n| n.values().map(|v| v.tx_bytes).sum())
                .unwrap_or(0),
            block_read_bytes: 0,  // TODO: parse blkio stats
            block_write_bytes: 0,
        })
    }

    async fn update_container(&self, id: &str, opts: orca_core::runtime::ContainerUpdateOpts) -> anyhow::Result<()> {
        let restart_policy = opts.restart_policy.map(|p| {
            bollard::models::RestartPolicy {
                name: Some(match p.as_str() {
                    "always" => bollard::models::RestartPolicyNameEnum::ALWAYS,
                    "unless-stopped" => bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED,
                    "on-failure" => bollard::models::RestartPolicyNameEnum::ON_FAILURE,
                    _ => bollard::models::RestartPolicyNameEnum::NO,
                }),
                maximum_retry_count: None,
            }
        });

        // Docker's container update API does not support NanoCpus.
        // Use CpuPeriod + CpuQuota instead: quota = cores * period.
        let (cpu_period, cpu_quota) = if let Some(cores) = opts.cpu_limit {
            let period: i64 = 100_000; // default 100ms in microseconds
            let quota = (cores * period as f64) as i64;
            (Some(period), Some(quota))
        } else {
            (None, None)
        };

        let config = UpdateContainerOptions::<String> {
            memory: opts.memory_limit.map(|m| m as i64),
            memory_swap: opts.memory_swap,
            cpu_period,
            cpu_quota,
            restart_policy,
            ..Default::default()
        };

        self.docker.update_container(id, config).await?;
        Ok(())
    }

    async fn exec(&self, opts: ExecOpts) -> anyhow::Result<ExecResult> {
        let exec = self
            .docker
            .create_exec(
                &opts.container,
                CreateExecOptions {
                    cmd: Some(opts.command.clone()),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(opts.tty),
                    env: Some(
                        opts.env
                            .iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect(),
                    ),
                    working_dir: opts.workdir.clone(),
                    ..Default::default()
                },
            )
            .await?;

        let mut collected = String::new();
        let started = self.docker.start_exec(&exec.id, None).await?;
        match started {
            StartExecResults::Attached { mut output, .. } => {
                while let Some(Ok(msg)) = output.next().await {
                    collected.push_str(&msg.to_string());
                }
            }
            StartExecResults::Detached => {}
        }

        let inspect = self.docker.inspect_exec(&exec.id).await?;
        Ok(ExecResult {
            exit_code: inspect.exit_code.unwrap_or(-1) as i32,
            output: collected,
        })
    }
}

fn parse_state(state: &str) -> ContainerState {
    match state.to_lowercase().as_str() {
        "created" => ContainerState::Created,
        "running" => ContainerState::Running,
        "paused" => ContainerState::Paused,
        "restarting" => ContainerState::Restarting,
        "exited" | "stopped" => ContainerState::Exited,
        "dead" => ContainerState::Dead,
        _ => ContainerState::Dead,
    }
}

fn summary_to_container(c: &bollard::models::ContainerSummary) -> Container {
    let ports = c
        .ports
        .as_ref()
        .map(|ports| {
            ports
                .iter()
                .filter_map(|p| {
                    Some(PortMapping {
                        host_ip: p.ip.clone(),
                        host_port: p.public_port? as u16,
                        container_port: p.private_port as u16,
                        protocol: p.typ.map(|t| format!("{t:?}").to_lowercase()).unwrap_or_else(|| "tcp".into()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Container {
        id: c.id.clone().unwrap_or_default(),
        name: c
            .names
            .as_ref()
            .and_then(|n| n.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default(),
        image: c.image.clone().unwrap_or_default(),
        state: c
            .state
            .as_deref()
            .map(parse_state)
            .unwrap_or(ContainerState::Dead),
        ports,
        labels: c.labels.clone().unwrap_or_default(),
        created_at: c.created.map(|t| t.to_string()).unwrap_or_default(),
        exit_code: None,
        error: None,
        oom_killed: None,
        started_at: None,
        finished_at: None,
        command: None,
        env: None,
        mounts: None,
        memory_limit: None,
        cpu_limit: None,
        restart_policy: None,
    }
}

fn inspect_to_container(info: &bollard::models::ContainerInspectResponse) -> Container {
    let state = info
        .state
        .as_ref()
        .and_then(|s| s.status)
        .map(|s| parse_state(&format!("{s:?}")))
        .unwrap_or(ContainerState::Dead);

    let ports = info
        .network_settings
        .as_ref()
        .and_then(|ns| ns.ports.as_ref())
        .map(|ports| {
            ports
                .iter()
                .flat_map(|(key, bindings)| {
                    let parts: Vec<&str> = key.split('/').collect();
                    let container_port = parts[0].parse::<u16>().unwrap_or(0);
                    let protocol = parts.get(1).unwrap_or(&"tcp").to_string();

                    bindings
                        .iter()
                        .flatten()
                        .map(move |b| PortMapping {
                            host_ip: b.host_ip.clone(),
                            host_port: b
                                .host_port
                                .as_ref()
                                .and_then(|p| p.parse::<u16>().ok())
                                .unwrap_or(0),
                            container_port,
                            protocol: protocol.clone(),
                        })
                })
                .collect()
        })
        .unwrap_or_default();

    let state_info = info.state.as_ref();

    let mounts = info
        .mounts
        .as_ref()
        .map(|ms| {
            ms.iter()
                .map(|m| ContainerMount {
                    source: m.source.clone().unwrap_or_default(),
                    destination: m.destination.clone().unwrap_or_default(),
                    mode: m.mode.clone().unwrap_or_default(),
                    rw: m.rw.unwrap_or(false),
                })
                .collect()
        });

    let host_config = info.host_config.as_ref();

    // Extract memory limit (0 means unlimited in Docker)
    let memory_limit = host_config
        .and_then(|hc| hc.memory)
        .filter(|&m| m > 0)
        .map(|m| m as u64);

    // Extract CPU limit: try NanoCPUs first, then fall back to CpuPeriod/CpuQuota
    // (Docker's update API uses period/quota, not NanoCPUs)
    let cpu_limit = host_config
        .and_then(|hc| hc.nano_cpus)
        .filter(|&c| c > 0)
        .map(|c| c as f64 / 1_000_000_000.0)
        .or_else(|| {
            let period = host_config?.cpu_period.filter(|&p| p > 0)?;
            let quota = host_config?.cpu_quota.filter(|&q| q > 0)?;
            Some(quota as f64 / period as f64)
        });

    // Extract restart policy
    let restart_policy = host_config
        .and_then(|hc| hc.restart_policy.as_ref())
        .and_then(|rp| rp.name)
        .map(|name| match name {
            bollard::models::RestartPolicyNameEnum::ALWAYS => "always".to_string(),
            bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED => "unless-stopped".to_string(),
            bollard::models::RestartPolicyNameEnum::ON_FAILURE => "on-failure".to_string(),
            _ => "no".to_string(),
        });

    Container {
        id: info.id.clone().unwrap_or_default(),
        name: info
            .name
            .as_ref()
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default(),
        image: info.config.as_ref().and_then(|c| c.image.clone()).unwrap_or_default(),
        state,
        ports,
        labels: info
            .config
            .as_ref()
            .and_then(|c| c.labels.clone())
            .unwrap_or_default(),
        created_at: info.created.clone().unwrap_or_default(),
        exit_code: state_info.and_then(|s| s.exit_code),
        error: state_info.and_then(|s| s.error.clone()).filter(|e| !e.is_empty()),
        oom_killed: state_info.and_then(|s| s.oom_killed),
        started_at: state_info.and_then(|s| s.started_at.clone()).filter(|s| !s.starts_with("0001")),
        finished_at: state_info.and_then(|s| s.finished_at.clone()).filter(|s| !s.starts_with("0001")),
        command: info.config.as_ref().and_then(|c| c.cmd.clone()),
        env: info.config.as_ref().and_then(|c| c.env.clone()),
        mounts,
        memory_limit,
        cpu_limit,
        restart_policy,
    }
}
