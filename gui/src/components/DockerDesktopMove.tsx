import { createSignal, For, onMount, Show } from "solid-js";
import { desktopApi, engineApi, ownEngine, type DesktopStatus, type MoveFrom, type MoveOutcome, type MovePlan } from "../lib/engine";
import { devApi, followJob, type DevJob } from "../lib/dev";
import { formatBytes } from "../lib/format";
import { confirm } from "./ConfirmDialog";
import { showToast } from "./Toast";
import { JobSteps } from "./dev/DevBits";
import HelpLink from "./HelpLink";

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
      showToast(`${src()} stopped`, "success");
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
            fallback={<>What's in {src()} was left there.</>}
          >
            Brought over from {src()} on {when(status()!.moved_at)}.
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
              fallback={<>An earlier Orca ran Docker in your own WSL distro; Orca now runs it {ownEngine()}. </>}
            >
              Orca runs Docker {ownEngine()}, not in Docker Desktop's.{" "}
            </Show>
            What's in {src()} stays there until you bring it over: images, volumes and compose projects,
            copied once and checked.{" "}
            <HelpLink path="/docs/docker-desktop/" />
          </div>

          {/* 1. Orca's engine first. */}
          <Show when={!status()!.orca_ready && !job()}>
            <div class="ddm-step">
              Set up Orca's engine first (a few minutes). {src()} isn't touched.
            </div>
            <div class="ddm-actions">
              <button class="btn btn-primary" onClick={() => props.onSetup()}>Set up Orca's engine</button>
              <Show
                when={!status()!.outcome}
                fallback={<button class="btn" onClick={() => setOpen(false)}>Close</button>}
              >
                <button class="btn" onClick={startFresh}>Start fresh, don't bring anything</button>
              </Show>
            </div>
          </Show>

          {/* 2. The source has to run to read what's in it. */}
          <Show when={status()!.orca_ready && !status()!.running && !job()}>
            <div class="ddm-step">{src()} isn't running. Start it to see what can come over.</div>
            <div class="ddm-actions">
              <button class="btn btn-primary" disabled={busy() === "start"} onClick={startDesktop}>
                {busy() === "start" ? `Starting ${src()}...` : `Start ${src()}`}
              </button>
              <Show
                when={!status()!.outcome}
                fallback={<button class="btn" onClick={() => setOpen(false)}>Close</button>}
              >
                <button class="btn" onClick={startFresh}>Start fresh, don't bring anything</button>
              </Show>
            </div>
          </Show>

          {/* 3. What's there. */}
          <Show when={status()!.orca_ready && status()!.running && !plan() && !job()}>
            <Show when={status()!.counts}>
              {(c) => (
                <div class="ddm-step">
                  {src()} has {c().containers} containers, {c().images} images and {c().volumes} volumes.
                </div>
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
                fallback={<button class="btn" onClick={() => setOpen(false)}>Close</button>}
              >
                <button class="btn" onClick={startFresh}>Start fresh, don't bring anything</button>
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
                      <b>{toCopy().images.length}</b> images · {formatBytes(total(toCopy().images.map((i) => i.size)))}
                    </span>
                    <span class="ddm-chip">
                      <b>{toCopy().volumes.length}</b> volumes · {formatBytes(total(toCopy().volumes.map((v) => v.size)))}
                    </span>
                    <span class="ddm-chip"><b>{toCopy().projects.length}</b> compose projects</span>
                    <Show when={p.networks.length > 0}>
                      <span class="ddm-chip"><b>{p.networks.length}</b> networks</span>
                    </Show>
                  </div>
                  <div class={shortSpace() ? "ddm-error" : "ddm-muted"}>
                    Needs about {formatBytes(needed())}
                    <Show when={p.bytes_free !== null}>; Orca's engine has {formatBytes(p.bytes_free!)} free</Show>.
                    <Show when={shortSpace()}> Free some space, or leave the images out: they can be pulled again.</Show>
                  </div>

                  <details class="ddm-list">
                    <summary>Images ({p.images.length})</summary>
                    <For each={p.images}>
                      {(i) => (
                        <div class="ddm-row">
                          <span class="ddm-mono">{i.tags[0] ?? i.digests[0]}</span>
                          <Show when={i.tags.length > 1}><span class="ddm-muted">+{i.tags.length - 1} tags</span></Show>
                          <span class="ddm-muted">{formatBytes(i.size)}</span>
                          <Show when={i.in_orca}><span class="ddm-badge">in Orca already</span></Show>
                        </div>
                      )}
                    </For>
                  </details>
                  <details class="ddm-list">
                    <summary>Volumes ({p.volumes.length})</summary>
                    <For each={p.volumes}>
                      {(v) => (
                        <div class="ddm-row">
                          <span class="ddm-mono">{v.name}</span>
                          <Show when={v.size !== null}><span class="ddm-muted">{formatBytes(v.size!)}</span></Show>
                          <Show when={v.in_orca === "done"}><span class="ddm-badge">copied before</span></Show>
                          <Show when={v.in_orca === "theirs"}><span class="ddm-badge">in Orca already: left as it is</span></Show>
                          <Show when={v.in_orca === "partial"}><span class="ddm-badge">half copied: copied again</span></Show>
                          <Show when={v.note}><span class="ddm-muted">{v.note}</span></Show>
                        </div>
                      )}
                    </For>
                    <Show when={p.anonymous_volumes > 0}>
                      <div class="ddm-muted">
                        {p.anonymous_volumes} anonymous volumes (made by containers for themselves) stay: compose makes new ones.
                      </div>
                    </Show>
                  </details>
                  <details class="ddm-list" open>
                    <summary>Compose projects ({p.projects.length})</summary>
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
                            {x.services.filter((s) => s.running).length}/{x.services.length} running
                          </span>
                          <Show when={x.in_orca}><span class="ddm-badge">in Orca already</span></Show>
                          <Show when={x.problem}><span class="ddm-warn">{x.problem}: not recreated</span></Show>
                        </label>
                      )}
                    </For>
                  </details>

                  <Show when={p.to_stop.length > 0}>
                    <div class="ddm-muted">
                      First stops {p.to_stop.length} running containers in {src()}, so databases are copied at
                      rest: {p.to_stop.join(", ")}. Its images and volumes aren't changed.
                    </div>
                  </Show>
                  <Show when={p.standalone.length > 0}>
                    <div class="ddm-muted">
                      Containers outside compose aren't recreated ({p.standalone.join(", ")}); their images and
                      volumes still come over.
                    </div>
                  </Show>

                  <div class="ddm-options">
                    <label><input type="checkbox" checked={images()} onChange={(e) => setImages(e.currentTarget.checked)} /> Images</label>
                    <label><input type="checkbox" checked={volumes()} onChange={(e) => setVolumes(e.currentTarget.checked)} /> Volumes</label>
                    <label><input type="checkbox" checked={projects()} onChange={(e) => setProjects(e.currentTarget.checked)} /> Compose projects</label>
                    <Show when={!navigator.platform.includes("Win")}>
                      <label><input type="checkbox" checked={switchCli()} onChange={(e) => setSwitchCli(e.currentTarget.checked)} /> Point the <code>docker</code> command at Orca's engine</label>
                    </Show>
                    <label><input type="checkbox" checked={quitDesktop()} onChange={(e) => setQuitDesktop(e.currentTarget.checked)} /> {from() === "desktop" ? "Quit Docker Desktop" : `Stop ${src()}`} when done</label>
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
                      <button class="btn" onClick={startFresh}>Start fresh instead</button>
                    </Show>
                    <button class="btn" onClick={() => { setPlan(null); setOpen(false); }}>Cancel</button>
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
                  <div class="ddm-muted">Nothing in {src()} was removed. Fix the cause and try again: what came over already is kept.</div>
                </Show>
                <Show when={j().status === "succeeded" && outcome()}>
                  {(o) => (
                    <div>
                      <div class="ddm-done">
                        Brought over {o().images + o().images_pulled} images, {o().volumes} volumes and {o().projects} compose projects.
                      </div>
                      <Show when={o().problems.length > 0}>
                        <div class="ddm-error">
                          These didn't come over and are still only in {src()}:
                          <ul><For each={o().problems}>{(m) => <li>{m}</li>}</For></ul>
                          Try again to retry them.
                        </div>
                      </Show>
                      <Show when={o().left.length > 0}>
                        <details class="ddm-list">
                          <summary>Not recreated ({o().left.length})</summary>
                          <For each={o().left}>{(m) => <div class="ddm-row ddm-muted">{m}</div>}</For>
                        </details>
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={j().status !== "running"}>
                  <div class="ddm-actions">
                    <button class="btn btn-primary" onClick={() => { setJob(null); setPlan(null); setOpen(false); void refresh(); }}>Done</button>
                    <Show when={j().status !== "succeeded" || (outcome()?.problems.length ?? 0) > 0}>
                      <button class="btn" onClick={() => { setJob(null); void loadPlan(); }}>Try again</button>
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
