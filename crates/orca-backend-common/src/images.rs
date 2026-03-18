use bollard::image::{CreateImageOptions, ListImagesOptions, RemoveImageOptions};
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

    async fn pull(
        &self,
        reference: &str,
    ) -> anyhow::Result<tokio::sync::mpsc::Receiver<PullProgress>> {
        let reference = reference.to_string();
        let options = CreateImageOptions {
            from_image: reference.as_str(),
            ..Default::default()
        };
        let stream = self.docker.create_image(Some(options), None, None);
        // Collect the stream into a vec first to avoid lifetime issues with the spawned task
        let items: Vec<_> = stream.collect().await;
        let items: Vec<_> = items.into_iter().filter_map(|r| r.ok()).collect();
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        tokio::spawn(async move {
            for info in items {
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
        });

        Ok(rx)
    }

    async fn remove(&self, id: &str, force: bool) -> anyhow::Result<()> {
        self.docker
            .remove_image(
                id,
                Some(RemoveImageOptions { force, ..Default::default() }),
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

    async fn prune(&self) -> anyhow::Result<u64> {
        let result = self.docker.prune_images::<String>(None).await?;
        Ok(result
            .space_reclaimed
            .unwrap_or(0) as u64)
    }
}
