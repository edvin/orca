import { createSignal, createMemo, createEffect, on, onMount, onCleanup, untrack, For, Show, type JSX } from "solid-js";

/**
 * Virtualized, wrapping log list. Only the rows within the viewport (plus
 * OVERSCAN_PX above and below) exist in the DOM, so a 20k-line buffer costs
 * the same to render and scroll as a 50-line one.
 *
 * Rows keep `white-space: pre-wrap`, so their heights vary. Each row's
 * height is estimated from its character count (the font is monospace, so
 * chars-per-visual-line is known), then replaced by the real height once
 * the row has been rendered and measured. When estimates are corrected or
 * old rows are trimmed off the top, the first visible row is held in place
 * so the content under the user's eyes doesn't jump.
 *
 * The font family must be set on the list (via `class`/`style`) or inherited;
 * the size and line-height are set here from `fontSize`/`lineHeight`.
 */
export interface VirtualLogListProps {
  /** Row keys in display order, strictly ascending. A new array signals a data change. */
  keys: number[];
  /** Character count of a row's text — used to estimate its wrapped height. */
  textLength: (key: number) => number;
  /** Must return exactly one element per row. */
  renderRow: (key: number) => JSX.Element;
  fontSize: number;
  /** Unitless CSS line-height for the rows. */
  lineHeight: number;
  /** Horizontal px of each row not available to its text (name column, border). */
  gutter?: number;
  /** Keep the view pinned to the newest row. */
  follow: boolean;
  /** Called on every scroll with whether the view is within 50px of the bottom. */
  onScrolled?: (atBottom: boolean) => void;
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  class?: string;
  style?: JSX.CSSProperties;
  /** Rendered instead of the rows when `keys` is empty. */
  empty?: JSX.Element;
}

const OVERSCAN_PX = 600;
const PROBE_TEXT = "0".repeat(64);

interface Box { width: number; height: number; padTop: number }

/** First index i with arr[i] >= value (arr ascending). */
function lowerBound(arr: ArrayLike<number>, value: number, lo = 0, hi = arr.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sameKeys(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default function VirtualLogList(props: VirtualLogListProps) {
  let root: HTMLDivElement | undefined;
  let windowEl: HTMLDivElement | undefined;
  let probe: HTMLSpanElement | undefined;
  // Measured row heights (px) by key, valid for the current font size and
  // width — cleared when either changes.
  const measured = new Map<number, number>();
  let measuredFor = "";
  const rowKeys = new WeakMap<Element, number>();
  // First visible row and its offset from the viewport top.
  let anchorKey: number | null = null;
  let anchorDelta = 0;
  // scrollTop after our last programmatic scroll.
  let ownScrollTop = -1;

  // Read `props.keys` once per change — callers may pass a freshly built array.
  const keysProp = createMemo(() => props.keys, undefined, { equals: false });
  const [scrollTop, setScrollTop] = createSignal(0);
  const [box, setBox] = createSignal<Box>(
    { width: 0, height: 0, padTop: 0 },
    { equals: (a, b) => a.width === b.width && a.height === b.height && a.padTop === b.padTop },
  );
  const [charWidth, setCharWidth] = createSignal(0);
  const [measureTick, setMeasureTick] = createSignal(0);

  // Row offsets: offsets[i] is the top of row i, offsets[n] the total height.
  // O(n) over plain numbers — cheap next to any DOM work.
  const layout = createMemo(() => {
    measureTick();
    const keys = keysProp();
    const lineHeightPx = props.fontSize * props.lineHeight;
    const textWidth = box().width - (props.gutter ?? 0);
    const cw = charWidth();
    const sig = `${props.fontSize}|${props.lineHeight}|${textWidth}|${cw}`;
    if (sig !== measuredFor) {
      measured.clear();
      measuredFor = sig;
    }
    const perLine = cw > 0 && textWidth > cw ? Math.floor(textWidth / cw) : 0;
    const textLength = props.textLength;
    const n = keys.length;
    const offsets = new Float64Array(n + 1);
    let y = 0;
    for (let i = 0; i < n; i++) {
      offsets[i] = y;
      const h = measured.get(keys[i]);
      if (h !== undefined) y += h;
      else y += (perLine ? Math.max(1, Math.ceil(textLength(keys[i]) / perLine)) : 1) * lineHeightPx;
    }
    offsets[n] = y;
    // Forget heights of rows that have been trimmed off the buffer.
    if (n > 0 && measured.size > n + 2000) {
      for (const k of measured.keys()) if (k < keys[0]) measured.delete(k);
    }
    return { keys, offsets };
  });

  const range = createMemo(() => {
    const { keys, offsets } = layout();
    const { height, padTop } = box();
    const top = scrollTop() - padTop;
    // First row whose bottom is below the overscan top edge…
    const start = Math.max(0, lowerBound(offsets, top - OVERSCAN_PX + 0.001, 1) - 1);
    // …up to the first row starting below the overscan bottom edge.
    const end = Math.min(keys.length, lowerBound(offsets, top + height + OVERSCAN_PX, start));
    return { start, end };
  });

  const visible = createMemo(
    () => {
      const { keys } = layout();
      const { start, end } = range();
      return keys.slice(start, end);
    },
    [],
    { equals: sameKeys },
  );

  const recordAnchor = () => {
    if (!root) return;
    const { keys, offsets } = layout();
    const top = root.scrollTop - box().padTop;
    const i = Math.max(0, lowerBound(offsets, top + 0.001, 1) - 1);
    if (i < keys.length) {
      anchorKey = keys[i];
      anchorDelta = offsets[i] - top;
    } else {
      anchorKey = null;
    }
  };

  const stickToBottom = () => {
    if (!root) return;
    const bottom = root.scrollHeight - root.clientHeight;
    if (Math.abs(root.scrollTop - bottom) > 1) root.scrollTop = bottom;
    ownScrollTop = root.scrollTop;
    setScrollTop(root.scrollTop);
  };

  // After every data/layout change: stick to the bottom when following,
  // otherwise keep the anchor row where it was.
  createEffect(() => {
    const { keys, offsets } = layout();
    const follow = props.follow;
    const { padTop } = box();
    if (!root) return;
    if (follow) {
      stickToBottom();
    } else if (anchorKey !== null) {
      const i = lowerBound(keys, anchorKey);
      if (i < keys.length && keys[i] === anchorKey) {
        const want = offsets[i] - anchorDelta + padTop;
        if (Math.abs(root.scrollTop - want) > 1) {
          root.scrollTop = want;
          ownScrollTop = root.scrollTop;
          setScrollTop(root.scrollTop);
        }
      }
    }
    // While following, keep the anchor current so it is ready the moment
    // the user scrolls away; otherwise it only moves on user scrolls.
    if (follow || anchorKey === null) untrack(recordAnchor);
  });

  // Measure the rendered rows; if any differs from the height the layout
  // assumed, store it and re-run the layout. Converges after one pass since
  // a measured row then matches its stored height. Runs in a microtask so
  // the <For> below has applied the current window to the DOM (an effect can
  // run before it), and rows are matched to keys via `rowKeys`, not by
  // position.
  let measurePending = false;
  const measureRows = () => {
    measurePending = false;
    // Hidden (display:none) lists measure as 0 — don't record that.
    if (!windowEl || !root || root.clientWidth === 0) return;
    const { keys, offsets } = layout();
    let changed = false;
    for (const row of windowEl.children) {
      const key = rowKeys.get(row);
      if (key === undefined) continue;
      const i = lowerBound(keys, key);
      if (keys[i] !== key) continue;
      const h = row.getBoundingClientRect().height;
      measured.set(key, h);
      if (Math.abs(offsets[i + 1] - offsets[i] - h) > 0.5) changed = true;
    }
    if (changed) setMeasureTick((tx) => tx + 1);
    // The effect above may have pinned before the window's DOM caught up.
    else if (props.follow) stickToBottom();
  };
  createEffect(() => {
    visible();
    layout();
    if (!measurePending) {
      measurePending = true;
      queueMicrotask(measureRows);
    }
  });

  const measureBox = () => {
    if (!root) return;
    const cs = getComputedStyle(root);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    setBox({
      width: root.clientWidth - padL - padR,
      height: root.clientHeight,
      padTop: parseFloat(cs.paddingTop) || 0,
    });
  };

  const measureChar = () => {
    if (probe) setCharWidth(probe.getBoundingClientRect().width / PROBE_TEXT.length);
  };

  onMount(() => {
    measureBox();
    measureChar();
    const ro = new ResizeObserver(measureBox);
    if (root) ro.observe(root);
    // The web font may finish loading after mount and change glyph widths.
    document.fonts?.addEventListener?.("loadingdone", measureChar);
    onCleanup(() => {
      ro.disconnect();
      document.fonts?.removeEventListener?.("loadingdone", measureChar);
    });
  });

  createEffect(on(() => props.fontSize, measureChar, { defer: true }));

  const onScroll = () => {
    if (!root) return;
    setScrollTop(root.scrollTop);
    // Re-anchor only on scrolls we didn't cause; re-recording after our
    // own (sub-pixel rounded) restores would let the view creep.
    if (Math.abs(root.scrollTop - ownScrollTop) >= 1) recordAnchor();
    props.onScrolled?.(root.scrollHeight - root.scrollTop - root.clientHeight < 50);
  };

  return (
    <div
      ref={(el) => {
        root = el;
        if (typeof props.ref === "function") props.ref(el);
      }}
      class={props.class}
      style={{
        ...props.style,
        position: "relative",
        overflow: "auto",
        // We restore the scroll position ourselves; the browser's own
        // anchoring would double-correct.
        "overflow-anchor": "none",
        "font-size": `${props.fontSize}px`,
        "line-height": String(props.lineHeight),
      }}
      onScroll={onScroll}
    >
      {/* Measures one monospace character; the 0×0 clip keeps it out of the scroll area. */}
      <div style={{ position: "absolute", top: "0", left: "0", width: "0", height: "0", overflow: "hidden" }} aria-hidden="true">
        <span ref={probe} style={{ "white-space": "pre", visibility: "hidden" }}>{PROBE_TEXT}</span>
      </div>
      <Show when={keysProp().length > 0} fallback={props.empty}>
        <div style={{ position: "relative", height: `${layout().offsets[layout().keys.length]}px` }}>
          <div
            ref={windowEl}
            style={{
              position: "absolute",
              top: "0",
              left: "0",
              right: "0",
              transform: `translateY(${layout().offsets[range().start] ?? 0}px)`,
            }}
          >
            <For each={visible()}>
              {(key) => {
                const row = props.renderRow(key);
                if (row instanceof Element) rowKeys.set(row, key);
                return row;
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
