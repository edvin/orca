use bollard::models::EndpointSettings;
use bollard::network::{ConnectNetworkOptions, CreateNetworkOptions, DisconnectNetworkOptions};

use orca_core::network::*;

use crate::BollardRuntime;

impl NetworkManager for BollardRuntime {
    async fn list(&self) -> anyhow::Result<Vec<Network>> {
        let networks = self.docker.list_networks::<String>(None).await?;

        Ok(networks
            .iter()
            .map(|n| {
                let (subnet, gateway) = n
                    .ipam
                    .as_ref()
                    .and_then(|ipam| ipam.config.as_ref())
                    .and_then(|configs| configs.first())
                    .map(|c| (c.subnet.clone(), c.gateway.clone()))
                    .unwrap_or((None, None));

                Network {
                    id: n.id.clone().unwrap_or_default(),
                    name: n.name.clone().unwrap_or_default(),
                    driver: n.driver.clone().unwrap_or_default(),
                    subnet,
                    gateway,
                    labels: n.labels.clone().unwrap_or_default(),
                }
            })
            .collect())
    }

    async fn create(&self, name: &str, driver: &str) -> anyhow::Result<Network> {
        let options = CreateNetworkOptions {
            name,
            driver,
            ..Default::default()
        };
        let response = self.docker.create_network(options).await?;

        Ok(Network {
            id: response.id,
            name: name.to_string(),
            driver: driver.to_string(),
            subnet: None,
            gateway: None,
            labels: Default::default(),
        })
    }

    async fn remove(&self, name: &str) -> anyhow::Result<()> {
        self.docker.remove_network(name).await?;
        Ok(())
    }

    async fn inspect(&self, name: &str) -> anyhow::Result<Network> {
        let n = self.docker.inspect_network::<String>(name, None).await?;

        let (subnet, gateway) = n
            .ipam
            .as_ref()
            .and_then(|ipam| ipam.config.as_ref())
            .and_then(|configs| configs.first())
            .map(|c| (c.subnet.clone(), c.gateway.clone()))
            .unwrap_or((None, None));

        Ok(Network {
            id: n.id.unwrap_or_default(),
            name: n.name.unwrap_or_default(),
            driver: n.driver.unwrap_or_default(),
            subnet,
            gateway,
            labels: n.labels.unwrap_or_default(),
        })
    }

    async fn connect(&self, network: &str, container: &str) -> anyhow::Result<()> {
        self.docker
            .connect_network(
                network,
                ConnectNetworkOptions {
                    container,
                    endpoint_config: EndpointSettings::default(),
                },
            )
            .await?;
        Ok(())
    }

    async fn disconnect(&self, network: &str, container: &str) -> anyhow::Result<()> {
        self.docker
            .disconnect_network(
                network,
                DisconnectNetworkOptions {
                    container,
                    force: false,
                },
            )
            .await?;
        Ok(())
    }
}
