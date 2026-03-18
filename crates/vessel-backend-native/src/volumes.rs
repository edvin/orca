use std::collections::HashMap;

use bollard::volume::CreateVolumeOptions;

use vessel_core::volume::*;

use crate::NativeBackend;

impl VolumeManager for NativeBackend {
    async fn list(&self) -> anyhow::Result<Vec<Volume>> {
        let result = self.docker.list_volumes::<String>(None).await?;
        let volumes = result.volumes.unwrap_or_default();

        Ok(volumes
            .iter()
            .map(|v| Volume {
                name: v.name.clone(),
                driver: v.driver.clone(),
                mountpoint: v.mountpoint.clone(),
                labels: v.labels.clone(),
                created_at: v.created_at.clone().unwrap_or_default(),
            })
            .collect())
    }

    async fn create(
        &self,
        name: &str,
        labels: HashMap<String, String>,
    ) -> anyhow::Result<Volume> {
        let str_labels: HashMap<&str, &str> = labels
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let options = CreateVolumeOptions {
            name,
            labels: str_labels,
            ..Default::default()
        };
        let v = self.docker.create_volume(options).await?;
        Ok(Volume {
            name: v.name,
            driver: v.driver,
            mountpoint: v.mountpoint,
            labels: v.labels,
            created_at: v.created_at.unwrap_or_default(),
        })
    }

    async fn remove(&self, name: &str, force: bool) -> anyhow::Result<()> {
        self.docker.remove_volume(name, Some(bollard::volume::RemoveVolumeOptions { force })).await?;
        Ok(())
    }

    async fn inspect(&self, name: &str) -> anyhow::Result<Volume> {
        let v = self.docker.inspect_volume(name).await?;
        Ok(Volume {
            name: v.name,
            driver: v.driver,
            mountpoint: v.mountpoint,
            labels: v.labels,
            created_at: v.created_at.unwrap_or_default(),
        })
    }

    async fn prune(&self) -> anyhow::Result<u64> {
        let result = self.docker.prune_volumes::<String>(None).await?;
        Ok(result.space_reclaimed.unwrap_or(0) as u64)
    }
}
