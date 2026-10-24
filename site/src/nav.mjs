// The docs sidebar, in reading order. Each item is a page slug: a file in
// content/docs/<slug>.md, or one of SHARED_DOCS (kept in the repo's docs/).

export const NAV = [
  { title: "Getting started", items: ["introduction", "install", "quickstart", "platforms"] },
  { title: "Workspaces", items: ["workspaces", "workspaces-join", "workspaces-secrets", "workspaces-create", "workspaces-routes", "workspaces-migrate", "workspaces-reference", "workspaces-troubleshooting"] },
  { title: "Local development", items: ["gateway", "databases", "orca-yaml", "profiles", "worktrees"] },
  { title: "Working with Orca", items: ["containers", "stacks", "images-and-builds", "templates", "kubernetes"] },
  { title: "AI and automation", items: ["agents", "ai-assistant", "cli", "api", "auto-deploy"] },
  { title: "Servers and teams", items: ["remote-hosts", "security"] },
  { title: "Help", items: ["troubleshooting"] },
];

/** Docs whose source is the repo's docs/ folder, read on GitHub too. */
export const SHARED_DOCS = [
  {
    slug: "orca-yaml",
    file: "orca-yaml.md",
    title: "orca.yaml reference",
    nav: "orca.yaml",
    description: "Every key of orca.yaml: gateway routes, links, build targets, setup hooks and worktree instances.",
  },
  {
    slug: "profiles",
    file: "profiles.md",
    title: "Running only the services you need",
    nav: "Profiles",
    description: "Use Docker Compose profiles to switch optional services on and off per stack and per worktree, remembered on your machine.",
  },
];

/** Top navigation. */
export const TOP_NAV = [
  { label: "Docs", href: "/docs/introduction/", match: "/docs/" },
  { label: "Workspaces", href: "/workspaces/", match: "/workspaces/" },
  { label: "Download", href: "/download/", match: "/download/" },
  { label: "Changelog", href: "/changelog/", match: "/changelog/" },
];
