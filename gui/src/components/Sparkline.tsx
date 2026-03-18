interface SparklineProps {
  data: number[];
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

  const points = () => {
    const data = props.data;
    if (!data || data.length === 0) return "";
    if (data.length === 1) {
      const y = height() / 2;
      return `${0},${y} ${width()},${y}`;
    }

    const maxVal = props.max ?? Math.max(...data, 1);
    const padding = 1;
    const usableHeight = height() - padding * 2;
    const step = width() / (data.length - 1);

    return data
      .map((v, i) => {
        const x = i * step;
        const y = padding + usableHeight - (Math.min(v, maxVal) / maxVal) * usableHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const fillPoints = () => {
    const p = points();
    if (!p) return "";
    const h = height();
    const w = width();
    const data = props.data;
    if (!data || data.length === 0) return "";
    // Close the polygon along the bottom
    const lastX = data.length === 1 ? w : ((data.length - 1) * (w / (data.length - 1))).toFixed(1);
    return `0,${h} ${p} ${lastX},${h}`;
  };

  return (
    <span class="sparkline-container">
      <svg
        width={width()}
        height={height()}
        viewBox={`0 0 ${width()} ${height()}`}
        style={{ display: "block" }}
      >
        {props.data && props.data.length > 0 && (
          <>
            <polygon
              points={fillPoints()}
              fill={color()}
              opacity={fillOpacity()}
            />
            <polyline
              points={points()}
              fill="none"
              stroke={color()}
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}
