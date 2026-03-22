import { createSignal, For, Show } from "solid-js";

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

  const maxVal = () => {
    if (props.maxValue != null && props.maxValue > 0) return props.maxValue;
    const vals = props.data.map((d) => d.value);
    return Math.max(...vals, 1);
  };

  const pts = () => {
    const data = props.data;
    if (data.length === 0) return [];
    const cw = chartWidth();
    const ch = chartHeight();
    const pad = padding();
    const mv = maxVal();
    const xScale = cw / Math.max(data.length - 1, 1);
    return data.map((d, i) => ({
      x: pad.left + i * xScale,
      y: pad.top + ch - (Math.min(d.value, mv) / mv) * ch,
    }));
  };

  const linePath = () => {
    const points = pts();
    if (points.length < 2) return "";
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const cp1x = points[i - 1].x + dx / 3;
      const cp2x = points[i].x - dx / 3;
      path += ` C ${cp1x} ${points[i - 1].y}, ${cp2x} ${points[i].y}, ${points[i].x} ${points[i].y}`;
    }
    return path;
  };

  const areaPath = () => {
    const line = linePath();
    if (!line) return "";
    const points = pts();
    const lastX = points[points.length - 1].x;
    const firstX = points[0].x;
    const bottom = padding().top + chartHeight();
    return `${line} L ${lastX} ${bottom} L ${firstX} ${bottom} Z`;
  };

  const gradientId = () => `timechart-grad-${(props.color || "#58a6ff").replace("#", "")}`;

  const formatVal = (v: number) => {
    if (props.formatValue) return props.formatValue(v);
    return v.toFixed(0);
  };

  const timeLabel = (index: number) => {
    const data = props.data;
    if (data.length === 0) return "";
    const now = data[data.length - 1].time;
    const t = data[index].time;
    const diffSec = Math.round((now - t) / 1000);
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
    const xScale = cw / Math.max(data.length - 1, 1);

    // Show ~6 labels spread across the data
    const count = Math.min(6, data.length);
    for (let i = 0; i < count; i++) {
      const idx = i === count - 1 ? data.length - 1 : Math.round((i / (count - 1)) * (data.length - 1));
      labels.push({
        x: pad.left + idx * xScale,
        text: timeLabel(idx),
      });
    }
    return labels;
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (mini()) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const svgX = (relX / rect.width) * WIDTH;

    setMouseX(e.clientX);
    setMouseY(e.clientY);

    const pad = padding();
    const data = props.data;
    if (data.length < 2) {
      setHoverIndex(null);
      return;
    }
    const xScale = chartWidth() / Math.max(data.length - 1, 1);
    const idx = Math.round((svgX - pad.left) / xScale);
    if (idx >= 0 && idx < data.length) {
      setHoverIndex(idx);
    } else {
      setHoverIndex(null);
    }
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
