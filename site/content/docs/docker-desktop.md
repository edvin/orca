---
title: Moving from Docker Desktop
nav: From Docker Desktop
description: Orca never uses Docker Desktop's engine. Bring Docker Desktop's images, volumes and compose projects over once, or start fresh.
---

Orca never uses Docker Desktop's engine. It runs Docker in its own Lima VM on macOS, in a WSL distro of its own on Windows, and uses the computer's own Docker or Podman on Linux. What's in Docker Desktop stays there until you bring it over, once, from **System Health**. You can also start fresh: Docker Desktop keeps everything either way.

## Why Orca runs its own engine

Docker Desktop's VM (on Windows, its `docker-desktop` WSL distro) is Docker Desktop's to run. Orca's settings, its networking fixes and its Kubernetes only reach Orca's own engine, so Orca uses that one. Both can be installed side by side, and you don't have to uninstall Docker Desktop.

On macOS and Linux you can pick another engine, such as OrbStack or Colima, in **Settings** > **General** > **Engine**. Docker Desktop's engine isn't one of the choices.

## Bring things over

On **System Health**, the **Docker Desktop** card walks through it:

1. **Set up Orca's engine**, if it isn't set up yet. This takes a few minutes and doesn't touch Docker Desktop.
2. **Start Docker Desktop**, if it isn't running: Orca reads what's in it through its engine.
3. **See what comes over** lists the images, volumes and compose projects, their sizes, and the free space in Orca's VM.
4. **Bring them over** copies them and checks each one.

You can leave out images, volumes or compose projects, or single projects. Images left out are pulled again when a project starts.

## What comes over

| | |
|---|---|
| Images | Every tagged image, with all its tags. One Docker Desktop can't export is pulled again from its registry. |
| Volumes | Named volumes with their labels, so compose keeps owning them. Files keep their owners and modes. Each copy is read back and compared with the original. |
| Networks | Bridge networks made outside compose, which projects join as `external`. |
| Compose projects | Recreated from their own compose files and env files, under the same project name. Services that were running are started. |

When it's done, Orca can point the `docker` command at its engine and quit Docker Desktop. Both are options you tick before you start. On macOS the command gets the `lima-orca` context; on Linux, the `default` one instead of Docker Desktop's `desktop-linux`. On Windows Orca runs `docker` inside its own distro, so there is nothing to point.

## Windows: an earlier Orca's Docker

Orca before 0.66 installed Docker into your default WSL distro. If that Docker is still there, System Health shows a second card, **Docker in** your distro's name, that brings its images, volumes and projects over the same way. **Stop** it when done disables that Docker in your distro; it isn't uninstalled.

Compose projects you started from inside a distro (`/home/me/app`) are found in that distro and recreated from there.

## What stays in Docker Desktop

- **Containers outside compose**, started with `docker run`: their images and volumes come over, but the containers aren't recreated.
- **Anonymous volumes**, the ones a container makes for itself: compose makes new ones.
- **Projects whose folder or compose file is gone**: Orca needs the files to recreate them.
- **Volumes with a driver other than `local`**. Volumes with driver options (a folder on your computer, `tmpfs`) are made again with the same options, with nothing to copy.

## Safe to run again

Docker Desktop's images and volumes are only read. Before copying, Orca stops the running containers that use what moves, so databases are copied at rest. Those containers stay stopped in Docker Desktop.

If something doesn't come over, the summary says what and why, and it is still in Docker Desktop. Run it again: what came over already is skipped, a volume that stopped half way is copied again, and a project is only recreated once all its volumes arrived. Volumes and projects that were in Orca's engine already are left as they are.

## Start fresh instead

Choose **Start fresh, don't bring anything**. Orca's engine starts empty: projects are created again when you start them, images are pulled again, and volumes start empty. You can still bring things over later from **System Health**.
