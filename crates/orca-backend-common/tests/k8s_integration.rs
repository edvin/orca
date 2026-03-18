//! Integration tests for K3sManager.
//!
//! These tests require k3s to be installed and running.
//! Run with: cargo test -p orca-backend-common --test k8s_integration -- --ignored
//!
//! To set up k3s for testing:
//!   curl -sfL https://get.k3s.io | sh -
//!
//! These tests are ignored by default since they need k3s infrastructure.

use orca_backend_common::k8s::K3sManager;
use orca_core::kubernetes::K8sManager;

fn skip_if_no_k3s() -> bool {
    !std::path::Path::new("/etc/rancher/k3s/k3s.yaml").exists()
}

#[tokio::test]
#[ignore]
async fn test_cluster_status() {
    if skip_if_no_k3s() {
        eprintln!("Skipping: k3s not installed");
        return;
    }

    let manager = K3sManager::new();
    let status = manager.status().await.expect("Failed to get cluster status");

    assert!(status.enabled, "Cluster should be enabled");
    assert!(status.running, "Cluster should be running");
    assert!(status.version.is_some(), "Should have a version");
    assert!(status.node_name.is_some(), "Should have a node name");

    println!("Cluster version: {:?}", status.version);
    println!("Node: {:?} ({:?})", status.node_name, status.node_status);
    println!("Pods: {}/{}", status.pods_running, status.pods_total);
}

#[tokio::test]
#[ignore]
async fn test_list_namespaces() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let namespaces = manager.list_namespaces().await.expect("Failed to list namespaces");

    assert!(!namespaces.is_empty(), "Should have at least one namespace");

    let names: Vec<&str> = namespaces.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains(&"default"), "Should have 'default' namespace");
    assert!(names.contains(&"kube-system"), "Should have 'kube-system' namespace");

    println!("Namespaces: {names:?}");
}

#[tokio::test]
#[ignore]
async fn test_list_pods_kube_system() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let pods = manager
        .list_pods("kube-system")
        .await
        .expect("Failed to list pods");

    assert!(!pods.is_empty(), "kube-system should have pods");

    // k3s should have at least coredns and traefik
    let pod_names: Vec<&str> = pods.iter().map(|p| p.name.as_str()).collect();
    println!("kube-system pods: {pod_names:?}");

    let has_coredns = pods.iter().any(|p| p.name.contains("coredns"));
    assert!(has_coredns, "Should have a coredns pod");

    for pod in &pods {
        println!(
            "  {} status={} ready={} restarts={}",
            pod.name, pod.status, pod.ready, pod.restarts
        );
    }
}

#[tokio::test]
#[ignore]
async fn test_list_services_default() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let services = manager
        .list_services("default")
        .await
        .expect("Failed to list services");

    // default namespace should at least have the kubernetes service
    let has_kubernetes = services.iter().any(|s| s.name == "kubernetes");
    assert!(has_kubernetes, "Should have 'kubernetes' service in default namespace");

    for svc in &services {
        println!(
            "  {} type={} cluster_ip={:?} ports={}",
            svc.name,
            svc.service_type,
            svc.cluster_ip,
            svc.ports.len()
        );
    }
}

#[tokio::test]
#[ignore]
async fn test_list_deployments_kube_system() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let deployments = manager
        .list_deployments("kube-system")
        .await
        .expect("Failed to list deployments");

    assert!(!deployments.is_empty(), "kube-system should have deployments");

    for deploy in &deployments {
        println!(
            "  {} ready={}/{} images={:?}",
            deploy.name, deploy.replicas_ready, deploy.replicas_desired, deploy.images
        );
    }
}

#[tokio::test]
#[ignore]
async fn test_list_pvs() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let pvs = manager.list_pvs().await.expect("Failed to list PVs");

    // PVs may be empty if nothing has been provisioned
    println!("PVs: {} found", pvs.len());
    for pv in &pvs {
        println!(
            "  {} capacity={:?} status={} class={:?}",
            pv.name, pv.capacity, pv.status, pv.storage_class
        );
    }
}

#[tokio::test]
#[ignore]
async fn test_kubeconfig() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();
    let kubeconfig = manager.kubeconfig().await.expect("Failed to get kubeconfig");

    assert!(kubeconfig.contains("clusters:"), "Should be valid YAML kubeconfig");
    assert!(kubeconfig.contains("server:"), "Should have a server entry");
    println!("Kubeconfig length: {} bytes", kubeconfig.len());
}

#[tokio::test]
#[ignore]
async fn test_apply_and_delete_yaml() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();

    // Apply a simple configmap
    let yaml = r#"
apiVersion: v1
kind: ConfigMap
metadata:
  name: orca-test-cm
  namespace: default
data:
  test_key: test_value
"#;

    let output = manager
        .apply_yaml(yaml)
        .await
        .expect("Failed to apply YAML");
    println!("Apply output: {output}");
    assert!(
        output.contains("created") || output.contains("configured"),
        "Should create or configure the resource"
    );

    // Clean up
    let output = manager
        .delete_yaml(yaml)
        .await
        .expect("Failed to delete YAML");
    println!("Delete output: {output}");
    assert!(output.contains("deleted"), "Should delete the resource");
}

#[tokio::test]
#[ignore]
async fn test_pod_logs() {
    if skip_if_no_k3s() {
        return;
    }

    let manager = K3sManager::new();

    // Get logs from a coredns pod (should exist in kube-system)
    let pods = manager
        .list_pods("kube-system")
        .await
        .expect("Failed to list pods");

    let coredns = pods.iter().find(|p| p.name.contains("coredns"));
    if let Some(pod) = coredns {
        let logs = manager
            .pod_logs("kube-system", &pod.name, None, Some(10))
            .await
            .expect("Failed to get pod logs");

        println!("coredns logs ({} lines):", logs.len());
        for line in &logs {
            println!("  {line}");
        }
    } else {
        println!("No coredns pod found, skipping log test");
    }
}
