use bollard::image::{BuildImageOptions, CreateImageOptions, ListImagesOptions, RemoveImageOptions, TagImageOptions};
use tokio_stream::StreamExt;

use orca_core::image::*;

use crate::BollardRuntime;

impl ImageManager for BollardRuntime {
    async fn list(&self) -> anyhow::Result<Vec<Image>> {
        let options = ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        };
        let images = self.docker.list_images(Some(options)).await?;

        Ok(images
            .iter()
            .map(|img| Image {
                id: img.id.clone(),
                repo_tags: img.repo_tags.clone(),
                size_bytes: img.size as u64,
                created_at: img.created.to_string(),
            })
            .collect())
    }

    async fn pull(&self, reference: &str) -> anyhow::Result<tokio::sync::mpsc::Receiver<PullProgress>> {
        let reference = reference.to_string();
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let docker = self.docker.clone();

        tokio::spawn(async move {
            let options = CreateImageOptions {
                from_image: reference.as_str(),
                ..Default::default()
            };
            let mut stream = docker.create_image(Some(options), None, None);
            while let Some(result) = stream.next().await {
                match result {
                    Ok(info) => {
                        let progress = PullProgress {
                            layer: info.id.unwrap_or_default(),
                            status: info.status.unwrap_or_default(),
                            current: info
                                .progress_detail
                                .as_ref()
                                .and_then(|d| d.current)
                                .map(|c| c as u64)
                                .unwrap_or(0),
                            total: info
                                .progress_detail
                                .as_ref()
                                .and_then(|d| d.total)
                                .map(|t| t as u64)
                                .unwrap_or(0),
                        };
                        if tx.send(progress).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(PullProgress {
                                layer: String::new(),
                                status: format!("error: {e}"),
                                current: 0,
                                total: 0,
                            })
                            .await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    async fn remove(&self, id: &str, force: bool) -> anyhow::Result<()> {
        self.docker
            .remove_image(
                id,
                Some(RemoveImageOptions {
                    force,
                    ..Default::default()
                }),
                None,
            )
            .await?;
        Ok(())
    }

    async fn inspect(&self, id: &str) -> anyhow::Result<Image> {
        let info = self.docker.inspect_image(id).await?;
        Ok(Image {
            id: info.id.unwrap_or_default(),
            repo_tags: info.repo_tags.unwrap_or_default(),
            size_bytes: info.size.unwrap_or(0) as u64,
            created_at: info.created.unwrap_or_default(),
        })
    }

    async fn prune(&self) -> anyhow::Result<PruneResult> {
        let result = self.docker.prune_images::<String>(None).await?;
        let images_deleted = result
            .images_deleted
            .unwrap_or_default()
            .iter()
            .filter_map(|item| item.deleted.clone().or(item.untagged.clone()))
            .collect();
        Ok(PruneResult {
            images_deleted,
            space_reclaimed: result.space_reclaimed.unwrap_or(0) as u64,
        })
    }

    async fn tag(&self, source: &str, repo: &str, tag: &str) -> anyhow::Result<()> {
        self.docker
            .tag_image(source, Some(TagImageOptions { repo, tag }))
            .await?;
        Ok(())
    }

    async fn build(
        &self,
        context_path: &str,
        dockerfile: Option<&str>,
        tag: Option<&str>,
        build_args: Option<std::collections::HashMap<String, String>>,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<BuildProgress>> {
        let tar_bytes = create_build_context(context_path).await?;

        let dockerfile = dockerfile.unwrap_or("Dockerfile").to_string();
        let tag = tag.map(|t| t.to_string()).unwrap_or_default();

        let options = BuildImageOptions::<String> {
            dockerfile,
            rm: true,
            t: tag,
            buildargs: build_args.unwrap_or_default(),
            ..Default::default()
        };

        let (tx, rx) = tokio::sync::mpsc::channel(256);
        let docker = self.docker.clone();

        tokio::spawn(async move {
            let mut stream = docker.build_image(options, None, Some(tar_bytes.into()));
            while let Some(result) = stream.next().await {
                match result {
                    Ok(output) => {
                        let progress = BuildProgress {
                            stream: output.stream.unwrap_or_default(),
                            error: output.error,
                        };
                        if tx.send(progress).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(BuildProgress {
                                stream: String::new(),
                                error: Some(format!("{e}")),
                            })
                            .await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }
}

impl BollardRuntime {
    /// Pull an image with registry authentication credentials.
    pub async fn pull_with_auth(
        &self,
        reference: &str,
        auth: &orca_core::image::RegistryAuth,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<PullProgress>> {
        let reference = reference.to_string();
        let credentials = bollard::auth::DockerCredentials {
            username: Some(auth.username.clone()),
            password: Some(auth.password.clone()),
            serveraddress: auth.server.clone(),
            ..Default::default()
        };
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let docker = self.docker.clone();

        tokio::spawn(async move {
            let options = CreateImageOptions {
                from_image: reference.as_str(),
                ..Default::default()
            };
            let mut stream = docker.create_image(Some(options), None, Some(credentials));
            while let Some(result) = stream.next().await {
                match result {
                    Ok(info) => {
                        let progress = PullProgress {
                            layer: info.id.unwrap_or_default(),
                            status: info.status.unwrap_or_default(),
                            current: info
                                .progress_detail
                                .as_ref()
                                .and_then(|d| d.current)
                                .map(|c| c as u64)
                                .unwrap_or(0),
                            total: info
                                .progress_detail
                                .as_ref()
                                .and_then(|d| d.total)
                                .map(|t| t as u64)
                                .unwrap_or(0),
                        };
                        if tx.send(progress).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(PullProgress {
                                layer: String::new(),
                                status: format!("error: {e}"),
                                current: 0,
                                total: 0,
                            })
                            .await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }
}

/// Create a tar archive of the build context directory.
async fn create_build_context(path: &str) -> anyhow::Result<Vec<u8>> {
    use std::path::Path;

    let context_path = Path::new(path);
    if !context_path.is_dir() {
        anyhow::bail!("Build context '{path}' is not a directory");
    }

    // Respect .dockerignore if present (async, cheap).
    let ignore_patterns = load_dockerignore(context_path).await;

    // The actual tar build is blocking (synchronous stdlib fs + tar
    // writer). A large build context can take seconds to walk, which
    // would stall a tokio worker. Hand it off to spawn_blocking so the
    // async runtime stays responsive.
    let context_path = context_path.to_path_buf();
    let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let buf = Vec::new();
        let mut archive = tar::Builder::new(buf);
        add_dir_to_tar(&mut archive, &context_path, &context_path, &ignore_patterns)?;
        let bytes = archive.into_inner()?;
        Ok(bytes)
    })
    .await
    .map_err(|e| anyhow::anyhow!("build context task panicked: {e}"))??;
    Ok(bytes)
}

fn add_dir_to_tar(
    archive: &mut tar::Builder<Vec<u8>>,
    base: &std::path::Path,
    dir: &std::path::Path,
    ignore: &[String],
) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();

        // Skip .git and .dockerignore patterns
        if relative == ".git" || relative.starts_with(".git/") {
            continue;
        }
        if should_ignore(&relative, ignore) {
            continue;
        }

        // Use `entry.file_type()` (does NOT follow symlinks) rather than
        // `path.is_dir()`/`path.is_file()`, which do. Otherwise a symlink
        // pointing to e.g. `/etc/shadow` or outside the build context
        // would be silently resolved and shipped to the docker daemon.
        // Skip symlinks entirely — safer than trying to verify their
        // target stays inside the context.
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            tracing::debug!("build context: skipping symlink {relative}");
            continue;
        }

        if file_type.is_dir() {
            add_dir_to_tar(archive, base, &path, ignore)?;
        } else if file_type.is_file() {
            archive.append_path_with_name(&path, &relative)?;
        }
    }
    Ok(())
}

async fn load_dockerignore(context: &std::path::Path) -> Vec<String> {
    let ignore_path = context.join(".dockerignore");
    match tokio::fs::read_to_string(&ignore_path).await {
        Ok(contents) => contents
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect(),
        Err(_) => vec![],
    }
}

pub(crate) fn should_ignore(path: &str, patterns: &[String]) -> bool {
    for pattern in patterns {
        // Simple glob matching — handles "node_modules", "*.tmp", "target/"
        if pattern.ends_with('/') {
            let dir_pattern = pattern.trim_end_matches('/');
            if path == dir_pattern || path.starts_with(&format!("{dir_pattern}/")) {
                return true;
            }
        } else if pattern.contains('*') {
            let parts: Vec<&str> = pattern.split('*').collect();
            if parts.len() == 2 {
                let (prefix, suffix) = (parts[0], parts[1]);
                let filename = path.rsplit('/').next().unwrap_or(path);
                if filename.starts_with(prefix) && filename.ends_with(suffix) {
                    return true;
                }
            }
        } else if path == pattern || path.starts_with(&format!("{pattern}/")) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patterns(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn should_ignore_exact_match() {
        assert!(should_ignore("node_modules", &patterns(&["node_modules"])));
    }

    #[test]
    fn should_ignore_directory_pattern() {
        assert!(should_ignore("target/debug/foo", &patterns(&["target/"])));
    }

    #[test]
    fn should_ignore_wildcard() {
        assert!(should_ignore("file.tmp", &patterns(&["*.tmp"])));
    }

    #[test]
    fn should_ignore_no_match() {
        assert!(!should_ignore("src/main.rs", &patterns(&["node_modules"])));
    }

    #[test]
    fn should_ignore_nested_path() {
        assert!(should_ignore("node_modules/foo/bar", &patterns(&["node_modules"])));
    }

    #[test]
    fn should_ignore_empty_patterns() {
        assert!(!should_ignore("anything.rs", &patterns(&[])));
    }
}
