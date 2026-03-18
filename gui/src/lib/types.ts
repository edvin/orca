export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: PortMapping[];
  labels: Record<string, string>;
  created_at: string;
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
