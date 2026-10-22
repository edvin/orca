---
title: Kubernetes
nav: Kubernetes
description: Run a local k3s cluster from Orca, use it with kubectl and Helm through the orca context, and manage workloads, YAML, Helm releases and jobs.
---

Orca can install and run a single-node [k3s](https://k3s.io) cluster with Traefik ingress, and gives you a UI for the workloads in it. Use this page when you want a local Kubernetes cluster next to your containers, or want to know how Orca's cluster fits with your own `kubectl` setup.

![The Kubernetes page listing pods with status, restarts and actions](/assets/screens/kubernetes.webp)

## Enable the cluster

Open **Kubernetes** in the sidebar. If k3s isn't installed yet, the page offers to set it up.

1. Pick a **Container runtime**:
   - **Docker** (default) runs k3s on Docker, so images you build locally are usable in the cluster with no push or import.
   - **containerd** is the upstream Kubernetes default.
2. Click **Enable Kubernetes**.

A dialog streams the setup log while Orca downloads k3s and waits for the cluster to become ready. This can take several minutes the first time. When it's done the dialog shows **Kubernetes cluster ready**.

How the cluster is installed depends on your platform:

| Platform | Where k3s runs |
|---|---|
| Linux | On the host, installed with the k3s install script through `sudo` and started with systemd. |
| macOS | Inside the Lima VM that Orca uses for Docker. Set up Docker first under **System Health** if you haven't. |
| Windows | Inside WSL2. Run `wsl --install` first if WSL is missing. |

Orca installs k3s with the metrics server turned off, so the **CPU** and **Memory** columns for pods usually stay empty.

The runtime choice applies the next time the cluster is enabled or reset. To change the runtime of a cluster that already exists, reset it.

### Start, stop and reset

When the cluster is running, the **More actions** menu next to the cluster status has **Refresh**, **Traefik Info**, **Reset Cluster** and **Stop Kubernetes**. A stopped cluster shows **Start Kubernetes** and **Reset Kubernetes**.

> [!WARNING]
> Reset uninstalls k3s and deletes every workload, volume and setting in the cluster, then installs a fresh one.

You can do the same from the command line:

```bash
orca k8s status
orca k8s enable
orca k8s disable
orca k8s runtime containerd
```

## The orca context

Orca names the cluster, user and context in its kubeconfig `orca`, so it never clashes with a `default` entry you already have. Orca itself never reads your current context: every `kubectl` call it makes passes `--context orca`, and every Helm call passes `--kube-context orca`. That keeps Orca from acting on a remote cluster you happen to have selected.

On macOS and Windows, enabling the cluster merges the `orca` entries into `~/.kube/config` (`%USERPROFILE%\.kube\config` on Windows). Your other contexts stay as they are. The merge can set `current-context` to `orca`, so check it afterwards and switch back if you need to:

```bash
kubectl config current-context
kubectl config use-context <your-context>
```

On Linux, k3s writes its kubeconfig to `/etc/rancher/k3s/k3s.yaml`, readable by all users. If you have no `~/.kube/config`, Orca uses that file directly. If you do have one, Orca looks for an `orca` context in it, so merge one in:

```bash
sed -e 's/: default$/: orca/' /etc/rancher/k3s/k3s.yaml > /tmp/orca-k3s.yaml
KUBECONFIG=~/.kube/config:/tmp/orca-k3s.yaml kubectl config view --flatten > /tmp/kubeconfig.merged
mv /tmp/kubeconfig.merged ~/.kube/config && chmod 600 ~/.kube/config
rm /tmp/orca-k3s.yaml
```

Listing your existing file first keeps your current context.

## Use kubectl and Helm

Pass the context explicitly and your own tools work against the same cluster:

```bash
kubectl --context orca get pods -A
helm --kube-context orca list -A
```

To reach a service from your machine, use `kubectl port-forward`:

```bash
kubectl --context orca -n default port-forward svc/my-api 8080:80
```

## Browse resources

The Kubernetes page has one tab per resource group. Use the **Namespace** dropdown to choose which namespace the namespaced tabs show. The **+** next to it creates a namespace, and the delete button removes one, except for the system namespaces.

| Tab | What you can do |
|---|---|
| **Pods** | See status, restarts, age and IP. View logs, open a **Terminal**, edit YAML, restart or delete a pod. |
| **Deployments** | **Scale**, restart, view **Rollout history** and roll back to an earlier revision. Create and delete autoscalers with **+ Create HPA**. |
| **DaemonSets** | Edit YAML, delete. |
| **StatefulSets** | Scale, restart, edit YAML, delete. |
| **ReplicaSets** | Edit YAML, delete. |
| **Services** | See ports, **Expose** a service through an ingress, edit YAML. Network policies are listed here too. |
| **Ingresses** | Create one with **+ Create Ingress**, with optional TLS. Edit YAML. |
| **Storage** | Persistent volume claims, with **+ Create PVC** and delete. Persistent volumes and storage classes, read-only. |
| **Events** | Recent cluster events with type, reason, object and count. |
| **Config** | ConfigMaps and Secrets. View values, edit secret data, **+ Create Secret**. |
| **Helm** | Installed releases. See [Helm releases](#helm-releases). |
| **Jobs** | CronJobs and Jobs. See [Jobs and CronJobs](#jobs-and-cronjobs). |
| **CRDs** | Installed custom resource definitions, read-only. |
| **Topology** | A map of services, deployments and pods. |

The pod **Terminal** runs `sh` in the pod's default container. **Restart pod** deletes the pod, so its controller creates a new one.

## Edit YAML and apply

Every resource has a **View/Edit YAML** button. It opens the resource's live YAML in an editor. Change it and click **Apply Changes**, or press <kbd>Cmd</kbd>+<kbd>S</kbd> (<kbd>Ctrl</kbd>+<kbd>S</kbd> on Windows and Linux).

To create something new, click **+ Deploy** (**Deploy from YAML**). The editor starts with an example Pod that you can replace. A file can hold several documents separated by `---`.

Both run `kubectl apply` with your YAML, up to 1 MB. For safety, Orca only applies these kinds:

```text
Pod, Service, ConfigMap, Secret, Deployment, DaemonSet, StatefulSet, ReplicaSet,
Job, CronJob, Ingress, PersistentVolumeClaim, Namespace, HorizontalPodAutoscaler,
ServiceAccount, Role, RoleBinding, NetworkPolicy, IngressRoute, Middleware,
HelmChartConfig
```

Anything else, such as a ClusterRole or a CustomResourceDefinition, is rejected. Apply those with `kubectl --context orca apply -f`.

## Helm releases

The **Helm** tab lists releases in all namespaces, with chart, status, revision and update time. It needs the `helm` binary. If Orca can't find it, the tab shows an **Install Helm** button.

To install a chart, click **Install Chart** and fill in **Release Name**, **Chart** and **Namespace**. Add `key=value` overrides under **Set Values (optional)**. Orca runs `helm install` with `--create-namespace`, so the namespace doesn't have to exist.

Charts from a repository need that repository added first:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
```

Use the delete button on a release to uninstall it. For upgrades and rollbacks, use `helm --kube-context orca` directly.

## Topology

The **Topology** tab draws each service with its deployments and their pods, then deployments without a service, then **Standalone Pods**. Click a card to jump to that resource's tab.

![The Topology tab showing services connected to deployments and pods](/assets/screens/k8s-topology.webp)

Orca links resources by name, not by label selector: a service and a deployment are linked when one name contains the other, and pods are linked to the deployment whose name they start with. Resources with unrelated names show up as separate groups.

## Jobs and CronJobs

The **Jobs** tab has two sections.

**CronJobs** shows each schedule, whether it's suspended, active jobs and the last run. For each CronJob you can:

- **Trigger Job now**, which creates a job named `<cronjob>-manual-<timestamp>` from the CronJob's template
- **Suspend CronJob** or **Resume CronJob**
- view its YAML, or delete it, which stops future runs

**Jobs** shows status, completions, duration and start time, and lets you view YAML or delete a job together with its pods.

## Ingress and Traefik

k3s ships with Traefik as its ingress controller. Ingresses you create from Orca, with **+ Create Ingress** or a service's **Expose** button, are served by Traefik. The status bar shows how Traefik is wired up, which you configure on the [Gateway](/docs/gateway/) page, and **Traefik Dashboard** opens Traefik's own dashboard.
