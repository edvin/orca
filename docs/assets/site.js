// orca-desktop.com: theme, menu, copy buttons, search, table of contents,
// OS-aware download buttons, tabs and scroll reveals. No dependencies.

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;

  // --- Theme ---------------------------------------------------------------
  $$(".theme-toggle").forEach((b) =>
    b.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch {}
    }),
  );

  // --- Mobile menu -------------------------------------------------------
  const menu = $(".mobile-menu");
  const openMenu = (open) => {
    if (!menu) return;
    menu.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
    $$("[data-menu-open]").forEach((b) => b.setAttribute("aria-expanded", String(open)));
  };
  $$("[data-menu-open]").forEach((b) => b.addEventListener("click", () => openMenu(true)));
  $$("[data-menu-close]").forEach((b) => b.addEventListener("click", () => openMenu(false)));
  menu?.addEventListener("click", (e) => { if (e.target.closest("a")) openMenu(false); });

  // --- Copy buttons --------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy, [data-copy]");
    if (!btn) return;
    const text = btn.dataset.copy ?? btn.closest(".code")?.querySelector("pre")?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      btn.classList.add("copied");
      const old = btn.getAttribute("aria-label");
      btn.setAttribute("aria-label", "Copied");
      setTimeout(() => { btn.classList.remove("copied"); if (old) btn.setAttribute("aria-label", old); }, 1600);
    } catch {}
  });

  // --- Tabs ----------------------------------------------------------------
  $$("[data-tabs]").forEach((group) => {
    const tabs = $$("[role=tab]", group);
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        n.focus();
        select(n);
      });
    });
  });

  // --- OS detection ----------------------------------------------------------
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod|Android/.test(ua) ? null : /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "windows" : /Linux|X11/.test(ua) && !/Android/.test(ua) ? "linux" : null;
  if (os) {
    root.dataset.os = os;
    $$("[data-os-label]").forEach((el) => {
      const label = { mac: "macOS", windows: "Windows", linux: "Linux" }[os];
      el.textContent = el.dataset.osLabel.replace("{os}", label);
    });
    $$("[data-os-href]").forEach((el) => {
      const href = el.dataset[`href${os[0].toUpperCase()}${os.slice(1)}`];
      if (href) el.href = href;
    });
    $$(`[data-os-card="${os}"]`).forEach((el) => el.classList.add("is-yours"));
  }

  // --- Latest release ------------------------------------------------------
  // The page is built at release time; if a newer release is out since,
  // point download links at its files.
  const assetLinks = $$("[data-asset], [data-os-href]");
  if (assetLinks.length) {
    fetch("https://api.github.com/repos/edvin/orca/releases/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (!rel?.assets) return;
        const find = (re) => rel.assets.find((a) => re.test(a.name));
        $$("[data-asset]").forEach((el) => {
          const a = find(new RegExp(el.dataset.asset));
          if (!a) return;
          el.href = a.browser_download_url;
          const size = el.querySelector(".dl-size");
          if (size) size.textContent = `${Math.round(a.size / 1048576)} MB`;
        });
        const pats = { mac: /aarch64\.dmg$/, windows: /x64-setup\.exe$/, linux: /amd64\.AppImage$/ };
        if (os && pats[os]) {
          const a = find(pats[os]);
          if (a) $$("[data-os-href]").forEach((el) => (el.href = a.browser_download_url));
        }
      })
      .catch(() => {});
  }

  // --- Table of contents ---------------------------------------------------
  const tocLinks = $$(".toc a");
  if (tocLinks.length) {
    const targets = tocLinks.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
    const onScroll = () => {
      const y = window.scrollY + 120;
      let current = targets[0];
      for (const t of targets) if (t.offsetTop <= y) current = t;
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = targets[targets.length - 1];
      tocLinks.forEach((a) => a.classList.toggle("active", a.hash === `#${current?.id}`));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  // Keep the current sidebar item in view.
  $(".docs-sidebar [aria-current=page]")?.scrollIntoView({ block: "center" });

  // --- Reveal on scroll ------------------------------------------------------
  const reveal = $$(".reveal");
  if (reveal.length && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    reveal.forEach((el) => io.observe(el));
  } else reveal.forEach((el) => el.classList.add("in"));

  // --- Search --------------------------------------------------------------
  const dialog = $(".search-dialog");
  const input = $(".search-dialog input");
  const results = $(".search-results");
  let index = null;
  let selected = 0;
  let items = [];

  const load = async () => {
    if (index) return index;
    const res = await fetch("/assets/search.json");
    index = (await res.json()).map((e) => ({ ...e, lt: e.t.toLowerCase(), lh: e.h.toLowerCase(), lx: e.x.toLowerCase() }));
    return index;
  };
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const snippet = (text, words) => {
    const lower = text.toLowerCase();
    let at = -1;
    for (const w of words) { at = lower.indexOf(w); if (at >= 0) break; }
    let s = at > 60 ? "…" + text.slice(at - 50, at + 140) : text.slice(0, 180);
    s = escapeHtml(s);
    for (const w of words) if (w.length > 1) s = s.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return s;
  };
  const search = async (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { results.innerHTML = ""; results.classList.remove("none"); items = []; return; }
    const idx = await load();
    const scored = [];
    for (const e of idx) {
      let score = 0;
      let all = true;
      for (const w of words) {
        const inT = e.lt.includes(w), inH = e.lh.includes(w), inX = e.lx.includes(w);
        if (!inT && !inH && !inX) { all = false; break; }
        score += (inT ? 6 : 0) + (inH ? 8 : 0) + (inX ? 1 : 0);
        if (e.lh.startsWith(w)) score += 4;
      }
      if (all) scored.push([score - (e.h ? 0 : 1), e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    items = scored.slice(0, 12).map(([, e]) => e);
    selected = 0;
    results.classList.toggle("none", items.length === 0);
    results.innerHTML = items
      .map(
        (e, i) =>
          `<a class="sr-item" role="option" href="${e.u}" aria-selected="${i === 0}"><div class="sr-title">${escapeHtml(e.h || e.t)}${
            e.h ? ` <span>· ${escapeHtml(e.t)}</span>` : ""
          }</div><div class="sr-snippet">${snippet(e.x, words)}</div></a>`,
      )
      .join("");
  };
  const mark = () => $$(".sr-item", results).forEach((el, i) => {
    el.setAttribute("aria-selected", String(i === selected));
    if (i === selected) el.scrollIntoView({ block: "nearest" });
  });
  const openSearch = () => {
    if (!dialog) return;
    dialog.hidden = false;
    document.body.style.overflow = "hidden";
    input.value = "";
    results.innerHTML = "";
    input.focus();
    load();
  };
  const closeSearch = () => { if (dialog) { dialog.hidden = true; document.body.style.overflow = ""; } };
  $$("[data-search-open]").forEach((b) => b.addEventListener("click", openSearch));
  dialog?.addEventListener("click", (e) => { if (e.target === dialog) closeSearch(); });
  input?.addEventListener("input", () => search(input.value));
  input?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); mark(); }
    else if (e.key === "Enter" && items[selected]) { e.preventDefault(); location.href = items[selected].u; closeSearch(); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); dialog?.hidden ? openSearch() : closeSearch(); }
    else if (e.key === "/" && !/input|textarea/i.test(document.activeElement?.tagName ?? "") && dialog?.hidden) { e.preventDefault(); openSearch(); }
    else if (e.key === "Escape") { closeSearch(); openMenu(false); }
  });
  if (/Win|Linux/.test(navigator.platform)) $$(".search-trigger kbd").forEach((k) => (k.textContent = "Ctrl K"));
})();
