//! Bridge Docker/Podman events to Orca events.

use bollard::system::EventsOptions;
use tokio::sync::broadcast;
use tokio_stream::StreamExt;

use orca_core::event::{Event, EventKind};

use crate::BollardRuntime;

impl BollardRuntime {
    /// Start listening to Docker events and broadcast them as Orca events.
    /// Returns a broadcast receiver that the daemon can subscribe to.
    pub fn subscribe_events(&self) -> broadcast::Receiver<Event> {
        let (tx, rx) = broadcast::channel(256);

        let docker = self.docker.clone();
        tokio::spawn(async move {
            // Reconnect with exponential backoff. Without this, a single
            // transient error ended the event stream forever and the UI
            // stopped showing live updates until the user restarted the
            // daemon.
            let mut backoff_secs: u64 = 1;
            loop {
                let options = EventsOptions::<String> { ..Default::default() };
                let mut stream = docker.events(Some(options));
                let mut had_successful_read = false;

                while let Some(item) = stream.next().await {
                    match item {
                        Ok(event) => {
                            had_successful_read = true;
                            let kind = match (event.typ.as_ref().map(|t| format!("{t:?}")), event.action.as_deref()) {
                                (Some(typ), Some(action)) if typ.contains("Container") => {
                                    let id = event.actor.as_ref().and_then(|a| a.id.clone()).unwrap_or_default();
                                    let name = event
                                        .actor
                                        .as_ref()
                                        .and_then(|a| a.attributes.as_ref())
                                        .and_then(|attrs| attrs.get("name").cloned())
                                        .unwrap_or_default();

                                    match action {
                                        "create" => Some(EventKind::ContainerCreated { id, name }),
                                        "start" => Some(EventKind::ContainerStarted { id, name }),
                                        "stop" => Some(EventKind::ContainerStopped { id, name }),
                                        "destroy" => Some(EventKind::ContainerRemoved { id, name }),
                                        "die" => {
                                            let exit_code = event
                                                .actor
                                                .as_ref()
                                                .and_then(|a| a.attributes.as_ref())
                                                .and_then(|attrs| attrs.get("exitCode"))
                                                .and_then(|c| c.parse().ok())
                                                .unwrap_or(-1);
                                            Some(EventKind::ContainerDied { id, name, exit_code })
                                        }
                                        _ => None,
                                    }
                                }
                                (Some(typ), Some(action)) if typ.contains("Image") => {
                                    let id = event.actor.as_ref().and_then(|a| a.id.clone()).unwrap_or_default();

                                    match action {
                                        "pull" => Some(EventKind::ImagePulled {
                                            id: id.clone(),
                                            reference: id,
                                        }),
                                        "delete" | "untag" => Some(EventKind::ImageRemoved { id }),
                                        _ => None,
                                    }
                                }
                                (Some(typ), Some(action)) if typ.contains("Volume") => {
                                    let name = event.actor.as_ref().and_then(|a| a.id.clone()).unwrap_or_default();

                                    match action {
                                        "create" => Some(EventKind::VolumeCreated { name }),
                                        "destroy" => Some(EventKind::VolumeRemoved { name }),
                                        _ => None,
                                    }
                                }
                                _ => None,
                            };

                            if let Some(kind) = kind {
                                let event = Event {
                                    timestamp: chrono::Utc::now().to_rfc3339(),
                                    kind,
                                };
                                // Ignore send errors (no subscribers)
                                let _ = tx.send(event);
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Docker event stream error, will reconnect: {e}");
                            break;
                        }
                    }
                }

                // Reset backoff after a run with at least one good read;
                // otherwise grow it so we don't spin on a persistent failure
                // (e.g., Docker daemon down).
                if had_successful_read {
                    backoff_secs = 1;
                } else {
                    backoff_secs = (backoff_secs * 2).min(60);
                }
                tracing::info!("Docker event stream reconnecting in {backoff_secs}s");
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            }
        });

        rx
    }
}
