import { createSignal, For, onMount, Show } from "solid-js";
import { desktopApi, engineApi, ownEngine, type DesktopStatus, type MoveFrom, type MoveOutcome, type MovePlan } from "../lib/engine";
import { devApi, followJob, type DevJob } from "../lib/dev";
import { formatBytes } from "../lib/format";
import { confirm } from "./ConfirmDialog";
import { showToast } from "./Toast";
import { JobSteps } from "./dev/DevBits";
import HelpLink from "./HelpLink";
import { t } from "../lib/i18n";

/**
 * Docker Desktop on the System Health page: Orca runs its own engine, so
 * what is in Docker Desktop stays there until brought over here, once.
 * Starting fresh is fine too: projects are created again on their next start.
 * With `from="earlier"` (Windows), the same for the Docker an earlier Orca
 * put in the default WSL distro.
 */
export default function DockerDesktopMove(props: { from?: MoveFrom; onSetup: () => void; onMoved?: () => void }) {
  const from = () => props.from ?? "desktop";
  /** How the source is named: "Docker Desktop", "Docker in Ubuntu". */
  const src = () => (from() === "desktop" ? "Docker Desktop" : status()?.name ?? "the earlier Docker");
  const [status, setStatus] = createSignal<DesktopStatus | null>(null);
  // Hidden when Orca runs on an engine picked in Settings.
  const [otherEngine, setOtherEngine] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [plan, setPlan] = createSignal<MovePlan | null>(null);
  const [planError, setPlanError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [job, setJob] = createSignal<DevJob | null>(null);
  const [images, setImages] = createSignal(true);
  const [volumes, setVolumes] = createSignal(true);
  const [projects, setProjects] = createSignal(true);
  const [skip, setSkip] = createSignal<string[]>([]);
  const [switchCli, setSwitchCli] = createSignal(true);
  const [quitDesktop, setQuitDesktop] = createSignal(false);

  const refresh = async () => {
    try {
      const [s, e] = await Promise.all([desktopApi.status(from()), engineApi.status().catch(() => null)]);
      setStatus(s);
      setOtherEngine(e?.choice.kind === "socket" && !e.from_env);
      if (s.moving && !job()) void resume();
    } catch {
      setStatus(null);
    }
  };
  onMount(refresh);

  /** Follow a move started earlier (the page was left while it ran). */
  const resume = async () => {
    const scope = from() === "desktop" ? "docker-desktop" : "docker-desktop-earlier";
    const running = (await devApi.jobs(scope).catch(() => [])).find((j) => j.status === "running");
    if (running) void follow(running);
  };

  const follow = async (started: DevJob) => {
    setOpen(true);
    setJob(started);
    const done = await followJob(started.id, setJob);
    if (done.status === "succeeded") props.onMoved?.();
    await refresh();
  };

  const loadPlan = async () => {
    setOpen(true);
    setBusy("plan");
    setPlanError(null);
    try {
      setPlan(await desktopApi.plan(from()));
    } catch (e) {
      setPlanError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const startDesktop = async () => {
    setBusy("start");
    try {
      await desktopApi.start(from());
      await refresh();
      await loadPlan();
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const startFresh = async () => {
    const ok = await confirm({
      title: "Start fresh in Orca?",
      message:
        "Orca's engine starts empty: projects are created again when you start them, images are pulled " +
        `again, and volumes start empty. Everything stays in ${src()}, and you can still bring it ` +
        "over later from System Health.",
      confirmLabel: "Start fresh",
    });
    if (!ok) return;
    try {
      await desktopApi.leave(from());
      setOpen(false);
      await refresh();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const bringOver = async () => {
    setBusy("move");
    try {
      const started = await desktopApi.move({
        from: from(),
        images: images(),
        volumes: volumes(),
        projects: projects(),
        skip: skip(),
        switch_cli: switchCli(),
        quit_desktop: quitDesktop(),
      });
      void follow(started);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const quit = async () => {
    try {
      await desktopApi.quit(from());
      showToast(t("{value1} stopped", { value1: src() }), "success");
      await refresh();
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  const total = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const toCopy = () => {
    const p = plan();
    if (!p) return { images: [], volumes: [], projects: [] };
    return {
      images: p.images.filter((i) => !i.in_orca),
      volumes: p.volumes.filter((v) => v.action !== "skip" && v.in_orca !== "done" && v.in_orca !== "theirs"),
      projects: p.projects.filter((x) => !x.in_orca && !x.problem),
    };
  };
  const nothingToMove = () => {
    const c = toCopy();
    return plan() !== null && c.images.length + c.volumes.length + c.projects.length + (plan()!.networks.length) === 0;
  };
  /** What the ticked options need, as the daemon counts it. */
  const needed = () => {
    const c = toCopy();
    const p = plan();
    if (!p) return 0;
    const imageBytes = images() ? Math.min(total(c.images.map((i) => i.size)), p.bytes_needed) : 0;
    const volumeBytes = volumes() ? total(c.volumes.filter((v) => v.action === "copy").map((v) => v.size)) : 0;
    return imageBytes + volumeBytes;
  };
  const shortSpace = () => {
    const p = plan();
    return !!p && p.bytes_free !== null && needed() > Math.max(0, p.bytes_free - 2 * 1024 ** 3);
  };
  const outcome = () => job()?.result as unknown as MoveOutcome | undefined;
  const toggleSkip = (name: string, on: boolean) =>
    setSkip(on ? skip().filter((s) => s !== name) : [...skip(), name]);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");

  return (
    <Show when={status()?.installed && !otherEngine()}>
      {/* Decided already: a line, with a way back in. */}
      <Show when={status()?.outcome && !open()}>
        <div class="ddm-note">
          <Show
            when={status()!.outcome === "moved"}
            fallback={<>{t("What's in")} {src()} {t("was left there.")}</>}
          >
            {t("Brought over from")} {src()} {t("on")} {when(status()!.moved_at)}.
          </Show>{" "}
          {from() === "desktop" ? "Orca never uses Docker Desktop's engine." : ""}
          <button class="btn btn-sm" onClick={() => (status()!.running ? loadPlan() : setOpen(true))}>
            {status()!.outcome === "moved" ? "Check for more" : "Bring it over"}
          </button>
        </div>
      </Show>

      <Show when={!status()?.outcome || open()}>
        <div class="ddm-card">
          <div class="ddm-title">{src()}</div>
          <div class="ddm-lead">
            <Show
              when={from() === "desktop"}
              fallback={<>{t("An earlier Orca ran Docker in your own WSL distro; Orca now runs it")} {ownEngine()}. </>}
            >
              {t("Orca runs Docker")} {ownEngine()}{t(", not in Docker Desktop's.")}{" "}
            </Show>
            {t("What's in")} {src()} {t("stays there until you bring it over: images, volumes and compose projects, copied once and checked.")}{" "}
            <HelpLink path="/docs/docker-desktop/" />
          </div>

          {/* 1. Orca's engine first. */}
          <Show when={!status()!.orca_ready && !job()}>
            <div class="ddm-step">
              {t("Set up Orca's engine first (a few minutes).")} {src()} {t("isn't touched.")}</div>
            <div class="ddm-actions">
              <button class="btn btn-primary" onClick={() => props.onSetup()}>{t("Set up Orca's engine")}</button>
              <Show
                when={!status()!.outcome}
                fallback={<button class="btn" onClick={() => setOpen(false)}>{t("Close")}</button>}
              >
                <button class="btn" onClick={startFresh}>{t("Start fresh, don't bring anything")}</button>
              </Show>
            </div>
          </Show>

          {/* 2. The source has to run to read what's in it. */}
          <Show when={status()!.orca_ready && !status()!.running && !job()}>
            <div class="ddm-step">{src()} {t("isn't running. Start it to see what can come over.")}</div>
            <div class="ddm-actions">
              <button class="btn btn-primary" disabled={busy() === "start"} onClick={startDesktop}>
                {busy() === "start" ? `Starting ${src()}...` : `Start ${src()}`}
              </button>
              <Show
                when={!status()!.outcome}
                fallback={<button class="btn" onClick={() => setOpen(false)}>{t("Close")}</button>}
              >
                <button class="btn" onClick={startFresh}>{t("Start fresh, don't bring anything")}</button>
              </Show>
            </div>
          </Show>

          {/* 3. What's there. */}
          <Show when={status()!.orca_ready && status()!.running && !plan() && !job()}>
            <Show when={status()!.counts}>
              {(c) => (
                <div class="ddm-step">
                  {src()} {t("has")} {c().containers} {t("containers,")} {c().images} {t("images and")} {c().volumes} {t("volumes.")}</div>
              )}
            </Show>
            <Show when={planError()}>
              <div class="ddm-error">{planError()}</div>
            </Show>
            <div class="ddm-actions">
              <button class="btn btn-primary" disabled={busy() === "plan"} onClick={loadPlan}>
                {busy() === "plan" ? "Looking..." : "See what comes over"}
              </button>
              <Show
                when={!status()!.outcome}
                fallback={<button class="btn" onClick={() => setOpen(false)}>{t("Close")}</button>}
              >
                <button class="btn" onClick={startFresh}>{t("Start fresh, don't bring anything")}</button>
              </Show>
            </div>
          </Show>

          {/* 4. The plan. */}
          <Show when={plan() && !job()}>
            {(_) => {
              const p = plan()!;
              return (
                <div>
                  <div class="ddm-chips">
                    <span class="ddm-chip">
                      <b>{toCopy().images.length}</b> {t("images ·")} {formatBytes(total(toCopy().images.map((i) => i.size)))}
                    </span>
                    <span class="ddm-chip">
                      <b>{toCopy().volumes.length}</b> {t("volumes ·")} {formatBytes(total(toCopy().volumes.map((v) => v.size)))}
                    </span>
                    <span class="ddm-chip"><b>{toCopy().projects.length}</b> {t("compose projects")}</span>
                    <Show when={p.networks.length > 0}>
                      <span class="ddm-chip"><b>{p.networks.length}</b> {t("networks")}</span>
                    </Show>
                  </div>
                  <div class={shortSpace() ? "ddm-error" : "ddm-muted"}>
                    {t("Needs about")} {formatBytes(needed())}
                    <Show when={p.bytes_free !== null}>{t("; Orca's engine has")} {formatBytes(p.bytes_free!)} {t("free")}</Show>.
                    <Show when={shortSpace()}> {t("Free some space, or leave the images out: they can be pulled again.")}</Show>
                  </div>

                  <details class="ddm-list">
                    <summary>{t("Images (")}{p.images.length})</summary>
                    <For each={p.images}>
                      {(i) => (
                        <div class="ddm-row">
                          <span class="ddm-mono">{i.tags[0] ?? i.digests[0]}</span>
                          <Show when={i.tags.length > 1}><span class="ddm-muted">+{i.tags.length - 1} {t("tags")}</span></Show>
                          <span class="ddm-muted">{formatBytes(i.size)}</span>
                          <Show when={i.in_orca}><span class="ddm-badge">{t("in Orca already")}</span></Show>
                        </div>
                      )}
                    </For>
                  </details>
                  <details class="ddm-list">
                    <summary>{t("Volumes (")}{p.volumes.length})</summary>
                    <For each={p.volumes}>
                      {(v) => (
                        <div class="ddm-row">
                          <span class="ddm-mono">{v.name}</span>
                          <Show when={v.size !== null}><span class="ddm-muted">{formatBytes(v.size!)}</span></Show>
                          <Show when={v.in_orca === "done"}><span class="ddm-badge">{t("copied before")}</span></Show>
                          <Show when={v.in_orca === "theirs"}><span class="ddm-badge">{t("in Orca already: left as it is")}</span></Show>
                          <Show when={v.in_orca === "partial"}><span class="ddm-badge">{t("half copied: copied again")}</span></Show>
                          <Show when={v.note}><span class="ddm-muted">{v.note}</span></Show>
                        </div>
                      )}
                    </For>
                    <Show when={p.anonymous_volumes > 0}>
                      <div class="ddm-muted">
                        {p.anonymous_volumes} {t("anonymous volumes (made by containers for themselves) stay: compose makes new ones.")}</div>
                    </Show>
                  </details>
                  <details class="ddm-list" open>
                    <summary>{t("Compose projects (")}{p.projects.length})</summary>
                    <For each={p.projects}>
                      {(x) => (
                        <label class="ddm-row ddm-project">
                          <input
                            type="checkbox"
                            disabled={!!x.problem || x.in_orca || !projects()}
                            checked={!x.problem && !x.in_orca && !skip().includes(x.name)}
                            onChange={(e) => toggleSkip(x.name, e.currentTarget.checked)}
                          />
                          <span class="ddm-name">{x.name}</span>
                          <span class="ddm-muted ddm-mono" title={x.dir}>{x.dir}</span>
                          <span class="ddm-muted">
                            {x.services.filter((s) => s.running).length}/{x.services.length} {t("running")}</span>
                          <Show when={x.in_orca}><span class="ddm-badge">{t("in Orca already")}</span></Show>
                          <Show when={x.problem}><span class="ddm-warn">{x.problem}{t(": not recreated")}</span></Show>
                        </label>
                      )}
                    </For>
                  </details>

                  <Show when={p.to_stop.length > 0}>
                    <div class="ddm-muted">
                      {t("First stops")} {p.to_stop.length} {t("running containers in")} {src()}{t(", so databases are copied at rest:")}{p.to_stop.join(", ")}{t(". Its images and volumes aren't changed.")}</div>
                  </Show>
                  <Show when={p.standalone.length > 0}>
                    <div class="ddm-muted">
                      {t("Containers outside compose aren't recreated (")}{p.standalone.join(", ")}{t("); their images and volumes still come over.")}</div>
                  </Show>

                  <div class="ddm-options">
                    <label><input type="checkbox" checked={images()} onChange={(e) => setImages(e.currentTarget.checked)} /> {t("Images")}</label>
                    <label><input type="checkbox" checked={volumes()} onChange={(e) => setVolumes(e.currentTarget.checked)} /> {t("Volumes")}</label>
                    <label><input type="checkbox" checked={projects()} onChange={(e) => setProjects(e.currentTarget.checked)} /> {t("Compose projects")}</label>
                    <Show when={!navigator.platform.includes("Win")}>
                      <label><input type="checkbox" checked={switchCli()} onChange={(e) => setSwitchCli(e.currentTarget.checked)} /> {t("Point the")} <code>docker</code> {t("command at Orca's engine")}</label>
                    </Show>
                    <label><input type="checkbox" checked={quitDesktop()} onChange={(e) => setQuitDesktop(e.currentTarget.checked)} /> {from() === "desktop" ? "Quit Docker Desktop" : `Stop ${src()}`} {t("when done")}</label>
                  </div>

                  <div class="ddm-actions">
                    <button
                      class="btn btn-primary"
                      disabled={busy() === "move" || nothingToMove() || shortSpace() || !(images() || volumes() || projects())}
                      onClick={bringOver}
                    >
                      {nothingToMove() ? "Everything is in Orca already" : "Bring them over"}
                    </button>
                    <Show when={!status()!.outcome}>
                      <button class="btn" onClick={startFresh}>{t("Start fresh instead")}</button>
                    </Show>
                    <button class="btn" onClick={() => { setPlan(null); setOpen(false); }}>{t("Cancel")}</button>
                  </div>
                </div>
              );
            }}
          </Show>

          {/* 5. Moving, then what happened. */}
          <Show when={job()}>
            {(j) => (
              <div>
                <JobSteps steps={j().steps} />
                <Show when={j().status === "running"}>
                  <pre class="ddm-log">{j().log.slice(-8).join("\n")}</pre>
                </Show>
                <Show when={j().status === "failed"}>
                  <div class="ddm-error">{j().error}</div>
                  <div class="ddm-muted">{t("Nothing in")} {src()} {t("was removed. Fix the cause and try again: what came over already is kept.")}</div>
                </Show>
                <Show when={j().status === "succeeded" && outcome()}>
                  {(o) => (
                    <div>
                      <div class="ddm-done">
                        {t("Brought over")} {o().images + o().images_pulled} {t("images,")} {o().volumes} {t("volumes and")} {o().projects} {t("compose projects.")}</div>
                      <Show when={o().problems.length > 0}>
                        <div class="ddm-error">
                          {t("These didn't come over and are still only in")} {src()}:
                          <ul><For each={o().problems}>{(m) => <li>{m}</li>}</For></ul>
                          {t("Try again to retry them.")}</div>
                      </Show>
                      <Show when={o().left.length > 0}>
                        <details class="ddm-list">
                          <summary>{t("Not recreated (")}{o().left.length})</summary>
                          <For each={o().left}>{(m) => <div class="ddm-row ddm-muted">{m}</div>}</For>
                        </details>
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={j().status !== "running"}>
                  <div class="ddm-actions">
                    <button class="btn btn-primary" onClick={() => { setJob(null); setPlan(null); setOpen(false); void refresh(); }}>{t("Done")}</button>
                    <Show when={j().status !== "succeeded" || (outcome()?.problems.length ?? 0) > 0}>
                      <button class="btn" onClick={() => { setJob(null); void loadPlan(); }}>{t("Try again")}</button>
                    </Show>
                    <Show when={status()?.running}>
                      <button class="btn" onClick={quit}>{from() === "desktop" ? "Quit Docker Desktop" : `Stop ${src()}`}</button>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </Show>
  );
}
