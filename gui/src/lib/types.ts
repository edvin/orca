export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: PortMapping[];
  labels: Record<string, string>;
  created_at: string;
  memory_limit?: number;
  cpu_limit?: number;
  restart_policy?: string;
  health_status?: string;  // "healthy" | "unhealthy" | "starting" | "none" | null
  health_log?: Array<{ output: string; exit_code: number; started_at: string; finished_at: string }>;
  restart_count?: number;
}

export interface PortMapping {
  host_ip: string | null;
  host_port: number;
  container_port: number;
  protocol: string;
}

export interface ContainerStats {
  container_id: string;
  cpu_percent: number;
  memory_usage_bytes: number;
  memory_limit_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
}

export interface Image {
  id: string;
  repo_tags: string[];
  size_bytes: number;
  created_at: string;
}

export interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  created_at: string;
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  subnet: string | null;
  gateway: string | null;
  labels: Record<string, string>;
}

export interface ComposeProject {
  name: string;
  working_dir: string | null;
  config_file: string | null;
  services: ComposeService[];
  status: "Running" | "Partial" | "Stopped" | "Empty";
}

export interface ComposeService {
  name: string;
  container_id: string;
  container_name: string;
  image: string;
  state: string;
  ports: PortMapping[];
}

export interface MachineInfo {
  name: string;
  state: string;
  config: {
    name: string;
    cpus: number;
    memory_mb: number;
    disk_gb: number;
    runtime: string;
    mounts: any[];
  };
  backend: string;
}

// --- Kubernetes ---

export interface ClusterStatus {
  enabled: boolean;
  running: boolean;
  version: string | null;
  node_name: string | null;
  node_status: string | null;
  pods_running: number;
  pods_total: number;
  traefik_dashboard: string | null;
  error?: string;
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
  node: string | null;
  ip: string | null;
  containers: PodContainer[];
}

export interface PodContainer {
  name: string;
  image: string;
  ready: boolean;
  restart_count: number;
  state: string;
}

export interface Deployment {
  name: string;
  namespace: string;
  replicas_ready: number;
  replicas_desired: number;
  age: string;
  images: string[];
}

export interface K8sService {
  name: string;
  namespace: string;
  service_type: string;
  cluster_ip: string | null;
  external_ip: string | null;
  ports: ServicePort[];
  age: string;
}

export interface ServicePort {
  name: string | null;
  port: number;
  target_port: string;
  node_port: number | null;
  protocol: string;
}

export interface Ingress {
  name: string;
  namespace: string;
  hosts: string[];
  address: string | null;
  age: string;
}

export interface Namespace {
  name: string;
  status: string;
  age: string;
}

export interface PersistentVolumeClaim {
  name: string;
  namespace: string;
  status: string;
  volume: string | null;
  capacity: string | null;
  access_modes: string[];
  storage_class: string | null;
  age: string;
}

export interface PersistentVolume {
  name: string;
  capacity: string | null;
  access_modes: string[];
  reclaim_policy: string | null;
  status: string;
  claim: string | null;
  storage_class: string | null;
  age: string;
}

export interface K8sEvent {
  type: string;      // Normal, Warning
  reason: string;
  object: string;    // Pod/my-pod
  message: string;
  age: string;
  count: number;
}

export interface K8sConfigMap {
  name: string;
  namespace: string;
  keys: string[];
  data: Record<string, string>;
  age: string;
}

export interface K8sSecret {
  name: string;
  namespace: string;
  secret_type: string;
  keys: string[];
  data: Record<string, string>;  // base64-encoded values
  age: string;
}

export interface PodMetrics {
  name: string;
  cpu: string;
  memory: string;
}

export interface RolloutRevision {
  revision: number;
  change_cause: string | null;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  chart: string;
  status: string;
  revision: string;
  updated: string;
  app_version: string;
}

// --- K8s DaemonSets / StatefulSets / ReplicaSets ---

export interface K8sDaemonSet {
  name: string;
  namespace: string;
  desired: number;
  current: number;
  ready: number;
  node_selector?: string;
  images: string[];
  created_at: string;
}

export interface K8sStatefulSet {
  name: string;
  namespace: string;
  ready: string;  // "2/3" format
  replicas: number;
  images: string[];
  created_at: string;
}

export interface K8sReplicaSet {
  name: string;
  namespace: string;
  desired: number;
  current: number;
  ready: number;
  images: string[];
  owner?: string;
  created_at: string;
}

// --- K8s Jobs / CronJobs ---

export interface K8sJob {
  name: string;
  namespace: string;
  status: string;  // "Active" | "Succeeded" | "Failed"
  completions: string;  // "1/1" format
  duration: string;
  start_time?: string;
  created_at: string;
}

export interface K8sCronJob {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  active: number;
  last_schedule?: string;
  created_at: string;
}

// --- K8s HPAs, Network Policies, Storage Classes, CRDs ---

export interface HorizontalPodAutoscaler {
  name: string;
  namespace: string;
  reference: string;      // "Deployment/nginx"
  min_replicas: number;
  max_replicas: number;
  current_replicas: number;
  target_cpu?: string;    // "50%"
  current_cpu?: string;   // "30%"
  created_at: string;
}

export interface NetworkPolicy {
  name: string;
  namespace: string;
  pod_selector: string;
  policy_types: string[];  // ["Ingress", "Egress"]
  created_at: string;
}

export interface StorageClass {
  name: string;
  provisioner: string;
  reclaim_policy: string;
  volume_binding_mode: string;
  is_default: boolean;
  created_at: string;
}

export interface CustomResourceDefinition {
  name: string;
  group: string;
  kind: string;
  scope: string;  // "Namespaced" or "Cluster"
  versions: string[];
  created_at: string;
}

// --- Image Scanning ---

export interface ScanVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
}

export interface ScanTargetResult {
  Target: string;
  Class?: string;
  Type?: string;
  Vulnerabilities?: ScanVulnerability[];
}

export interface ScanResult {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  error?: string;
  results?: ScanTargetResult[];
}

// --- Registries ---

export interface RegistryCredential {
  server: string;
  name: string;
  username: string;
  // password is never sent to frontend for security
}

export interface ImageSearchResult {
  name: string;
  description: string;
  stars: number;
  official: boolean;
  pulls: string | null;
}

// --- System Health ---

export interface GpuInfo {
  name: string;
  memory_used_mb: number;
  memory_total_mb: number;
  utilization_percent: number;
}

export interface SystemHealth {
  docker_connected: boolean;
  docker_version: string | null;
  disk_usage: DiskUsage | null;
  system_resources: SystemResources | null;
  warnings: string[];
  gpu?: GpuInfo;
}

export interface DiskUsage {
  images_size_bytes: number;
  containers_size_bytes: number;
  volumes_size_bytes: number;
  build_cache_size_bytes: number;
  total_size_bytes: number;
  reclaimable_bytes: number;
}

export interface SystemResources {
  cpu_count: number;
  memory_total_bytes: number;
  memory_available_bytes: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  disk_usage_percent: number;
}

// --- Templates ---

export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  image: string;
  default_ports: string[];
  default_env: string[];
  default_volumes: string[];
  restart_policy: string;
  notes: string;
  is_builtin: boolean;
  compose_yaml?: string;
}

// --- AI ---

export interface AiQuery {
  query: string;
  context?: AiContext;
}

export interface AiContext {
  container_id?: string;
  container_name?: string;
  container_logs?: string;
  exit_code?: number;
  error?: string;
  image?: string;
}

export interface AiResponse {
  answer: string;
  suggestions: AiSuggestion[];
}

export interface AiSuggestion {
  label: string;
  action: string;
  detail: string;
}

// --- Remote Hosts ---

export interface RemoteHost {
  id: string;
  name: string;
  url: string;
  tls_verify: boolean;
  tags: string[];
}

export interface ActiveHost {
  id: string | null;
  name: string;
  url: string;
  is_remote: boolean;
}

// --- Fleet ---

export interface HostStatus {
  id: string | null;  // null = local
  name: string;
  url: string;
  tags?: string[];
  online: boolean;
  checking: boolean;
  version?: string;
  docker_connected?: boolean;
  cpu_count?: number;
  memory_total?: number;
  memory_available?: number;
  disk_usage_percent?: number;
  containers_running?: number;
  containers_total?: number;
  images_total?: number;
  os?: string;
  arch?: string;
  error?: string;
}

// --- Environment ---

export interface EnvironmentStatus {
  ready: boolean;
  platform: string;
  checks: HealthCheck[];
  suggested_runtime: string;
}

export interface HealthCheck {
  name: string;
  description: string;
  status: "Pass" | "Warning" | "Fail";
  fix_action: string | null;
  details: string | null;
}
