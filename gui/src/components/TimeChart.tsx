import { createMemo, createSignal, For, Show } from "solid-js";

export interface TimeChartProps {
  data: Array<{ time: number; value: number }>;
  height?: number;
  color?: string;
  fillColor?: string;
  maxValue?: number;
  unit?: string;
  label?: string;
  formatValue?: (v: number) => string;
  /** If true, renders a minimal chart with no axes/labels (for inline use) */
  mini?: boolean;
}

// Readings further apart than this are drawn as a gap rather than joined. Polls
// run at least once a minute even while the window is hidden, so a longer hole
// means nothing was read (the Mac slept).
export const MAX_JOIN_GAP_MS = 150_000;

/** Index ranges [start, end] of runs of readings with no gap longer than MAX_JOIN_GAP_MS. */
export function joinedRuns(times: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || times[i] - times[i - 1] > MAX_JOIN_GAP_MS) {
      if (times.length > 0) runs.push([start, i - 1]);
      start = i;
    }
  }
  return runs;
}

export default function TimeChart(props: TimeChartProps) {
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null);
  const [mouseX, setMouseX] = createSignal(0);
  const [mouseY, setMouseY] = createSignal(0);

  const WIDTH = 400;
  const height = () => props.height || 120;
  const mini = () => props.mini || false;
  const padding = () =>
    mini()
      ? { top: 2, right: 2, bottom: 2, left: 2 }
      : { top: 8, right: 8, bottom: 20, left: 40 };

  const chartWidth = () => WIDTH - padding().left - padding().right;
  const chartHeight = () => height() - padding().top - padding().bottom;

  // Geometry is memoised: the paths, axes and hover all read it, and the
  // dashboard redraws several charts on every stats poll.
  const maxVal = createMemo(() => {
    if (props.maxValue != null && props.maxValue > 0) return props.maxValue;
    let max = 1;
    for (const d of props.data) if (d.value > max) max = d.value;
    return max;
  });

  const pts = createMemo(() => {
    const data = props.data;
    if (data.length === 0) return [];
    const cw = chartWidth();
    const ch = chartHeight();
    const pad = padding();
    const mv = maxVal();
    // x follows the timestamps, so readings taken further apart (a hidden
    // window polls slower) take the room their time took
    const t0 = data[0].time;
    const span = Math.max(data[data.length - 1].time - t0, 1);
    return data.map((d) => ({
      x: pad.left + ((d.time - t0) / span) * cw,
      y: pad.top + ch - (Math.min(d.value, mv) / mv) * ch,
    }));
  });

  const runs = createMemo(() => joinedRuns(props.data.map((d) => d.time)));

  const curve = (points: Array<{ x: number; y: number }>, from: number, to: number) => {
    let path = `M ${points[from].x} ${points[from].y}`;
    for (let i = from + 1; i <= to; i++) {
      const dx = points[i].x - points[i - 1].x;
      const cp1x = points[i - 1].x + dx / 3;
      const cp2x = points[i].x - dx / 3;
      path += ` C ${cp1x} ${points[i - 1].y}, ${cp2x} ${points[i].y}, ${points[i].x} ${points[i].y}`;
    }
    return path;
  };

  const linePath = createMemo(() => {
    const points = pts();
    if (points.length < 2) return "";
    return runs()
      .filter(([a, b]) => b > a)
      .map(([a, b]) => curve(points, a, b))
      .join(" ");
  });

  const areaPath = createMemo(() => {
    const points = pts();
    if (points.length < 2) return "";
    const bottom = padding().top + chartHeight();
    return runs()
      .filter(([a, b]) => b > a)
      .map(([a, b]) => `${curve(points, a, b)} L ${points[b].x} ${bottom} L ${points[a].x} ${bottom} Z`)
      .join(" ");
  });

  const gradientId = () => `timechart-grad-${(props.color || "#58a6ff").replace("#", "")}`;

  const formatVal = (v: number) => {
    if (props.formatValue) return props.formatValue(v);
    return v.toFixed(0);
  };

  const timeLabel = (index: number) => {
    const data = props.data;
    if (data.length === 0) return "";
    return agoLabel(data[data.length - 1].time - data[index].time);
  };

  const agoLabel = (ms: number) => {
    const diffSec = Math.round(ms / 1000);
    if (diffSec <= 5) return "now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    return `${diffMin}m ago`;
  };

  const xAxisLabels = () => {
    const data = props.data;
    if (data.length < 2) return [];
    const labels: Array<{ x: number; text: string }> = [];
    const pad = padding();
    const cw = chartWidth();
    const span = data[data.length - 1].time - data[0].time;

    // ~6 labels at even steps of time, as the x axis is time
    const count = Math.min(6, data.length);
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      labels.push({
        x: pad.left + f * cw,
        text: agoLabel((1 - f) * span),
      });
    }
    return labels;
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (mini()) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const svgX = (relX / rect.width) * WIDTH;

    setMouseX(e.clientX);
    setMouseY(e.clientY);

    const pad = padding();
    const data = props.data;
    if (data.length < 2) {
      setHoverIndex(null);
      return;
    }
    if (svgX < pad.left || svgX > WIDTH - pad.right) {
      setHoverIndex(null);
      return;
    }
    // the reading nearest to the pointer; points are spaced by time, not evenly
    const points = pts();
    let idx = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].x - svgX) < Math.abs(points[idx].x - svgX)) idx = i;
    }
    setHoverIndex(idx);
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  const hoverPoint = () => {
    const idx = hoverIndex();
    if (idx == null) return null;
    const points = pts();
    if (idx < 0 || idx >= points.length) return null;
    return points[idx];
  };

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height()}`}
        style={{ width: "100%", height: `${height()}px`, display: "block" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id={gradientId()} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={props.fillColor || props.color || "#58a6ff"} stop-opacity="0.3" />
            <stop offset="100%" stop-color={props.fillColor || props.color || "#58a6ff"} stop-opacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid lines (not for mini) */}
        <Show when={!mini()}>
          <For each={[0, 0.25, 0.5, 0.75, 1]}>
            {(pct) => {
              const y = () => padding().top + chartHeight() * (1 - pct);
              return (
                <line
                  x1={padding().left}
                  y1={y()}
                  x2={WIDTH - padding().right}
                  y2={y()}
                  stroke="#21262d"
                  stroke-width="1"
                />
              );
            }}
          </For>
        </Show>

        {/* Area fill */}
        <Show when={props.data.length >= 2}>
          <path d={areaPath()} fill={`url(#${gradientId()})`} />
        </Show>

        {/* Line */}
        <Show when={props.data.length >= 2}>
          <path
            d={linePath()}
            fill="none"
            stroke={props.color || "#58a6ff"}
            stroke-width={mini() ? "1.5" : "1.5"}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </Show>

        {/* Y-axis labels (not for mini) */}
        <Show when={!mini()}>
          <For each={[0, 0.5, 1]}>
            {(pct) => {
              const y = () => padding().top + chartHeight() * (1 - pct);
              const val = () => maxVal() * pct;
              return (
                <text
                  x={padding().left - 4}
                  y={y() + 3}
                  text-anchor="end"
                  fill="#484f58"
                  font-size="9"
                  font-family="inherit"
                >
                  {formatVal(val())}
                </text>
              );
            }}
          </For>
        </Show>

        {/* X-axis labels (not for mini) */}
        <Show when={!mini()}>
          <For each={xAxisLabels()}>
            {(label) => (
              <text
                x={label.x}
                y={height() - 4}
                text-anchor="middle"
                fill="#484f58"
                font-size="9"
                font-family="inherit"
              >
                {label.text}
              </text>
            )}
          </For>
        </Show>

        {/* Hover indicator */}
        <Show when={!mini() && hoverPoint()}>
          {(point) => (
            <>
              <line
                x1={point().x}
                y1={padding().top}
                x2={point().x}
                y2={padding().top + chartHeight()}
                stroke="#484f58"
                stroke-width="1"
                stroke-dasharray="3,3"
              />
              <circle
                cx={point().x}
                cy={point().y}
                r="3.5"
                fill={props.color || "#58a6ff"}
                stroke="#0d1117"
                stroke-width="1.5"
              />
            </>
          )}
        </Show>
      </svg>

      {/* Tooltip */}
      <Show when={!mini() && hoverIndex() != null}>
        {(_) => {
          const idx = hoverIndex()!;
          const d = () => props.data[idx];
          return (
            <Show when={d()}>
              <div
                style={{
                  position: "fixed",
                  left: `${mouseX() + 12}px`,
                  top: `${mouseY() - 32}px`,
                  background: "#1c2128",
                  border: "1px solid #30363d",
                  "border-radius": "6px",
                  padding: "6px 10px",
                  "font-size": "11px",
                  color: "#e6edf3",
                  "pointer-events": "none",
                  "z-index": "9999",
                  "white-space": "nowrap",
                  "box-shadow": "0 4px 12px rgba(0,0,0,0.4)",
                }}
              >
                <div style={{ "font-weight": "600" }}>{formatVal(d().value)}</div>
                <div style={{ color: "#8b949e", "font-size": "10px" }}>{timeLabel(idx)}</div>
              </div>
            </Show>
          );
        }}
      </Show>
    </div>
  );
}
