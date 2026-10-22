import { For } from "solid-js";
import { joinedRuns } from "./TimeChart";

interface SparklineProps {
  data: number[];
  /** When each value was read. With it, x follows time and long holes stay open; without it, values are evenly spaced. */
  times?: number[];
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  max?: number;
}

export default function Sparkline(props: SparklineProps) {
  const width = () => props.width ?? 80;
  const height = () => props.height ?? 24;
  const color = () => props.color ?? "#58a6ff";
  const fillOpacity = () => props.fillOpacity ?? 0.1;

  const xy = () => {
    const data = props.data;
    if (!data || data.length < 2) return [];
    const maxVal = props.max ?? Math.max(...data, 1);
    const padding = 1;
    const usableHeight = height() - padding * 2;
    const times = props.times?.length === data.length ? props.times : null;
    const t0 = times ? times[0] : 0;
    const span = times ? Math.max(times[times.length - 1] - t0, 1) : data.length - 1;
    return data.map((v, i) => ({
      x: ((times ? times[i] - t0 : i) / span) * width(),
      y: padding + usableHeight - (Math.min(v, maxVal) / maxVal) * usableHeight,
    }));
  };

  // Runs of joined points; a single value is drawn as a flat line across.
  const runs = (): Array<Array<{ x: number; y: number }>> => {
    const data = props.data;
    if (!data || data.length === 0) return [];
    if (data.length === 1) {
      const y = height() / 2;
      return [[{ x: 0, y }, { x: width(), y }]];
    }
    const pts = xy();
    const times = props.times?.length === data.length ? props.times : null;
    const ranges = times ? joinedRuns(times) : [[0, data.length - 1] as [number, number]];
    return ranges.filter(([a, b]) => b > a).map(([a, b]) => pts.slice(a, b + 1));
  };

  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

  return (
    <span class="sparkline-container">
      <svg
        width={width()}
        height={height()}
        viewBox={`0 0 ${width()} ${height()}`}
        style={{ display: "block" }}
      >
        <For each={runs()}>
          {(run) => (
          <>
            <polygon
              points={`${run[0].x.toFixed(1)},${height()} ${run.map(fmt).join(" ")} ${run[run.length - 1].x.toFixed(1)},${height()}`}
              fill={color()}
              opacity={fillOpacity()}
            />
            <polyline
              points={run.map(fmt).join(" ")}
              fill="none"
              stroke={color()}
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </>
          )}
        </For>
      </svg>
    </span>
  );
}
