import { Index } from "solid-js";
import type { JSX } from "solid-js";

/** Base skeleton loading placeholder — renders a shimmering gray bar */
export function Skeleton(props: {
  width?: string;
  height?: string;
  borderRadius?: string;
  style?: JSX.CSSProperties;
}) {
  return (
    <div
      class="skeleton-line"
      style={{
        width: props.width || "100%",
        height: props.height || "12px",
        "border-radius": props.borderRadius || "4px",
        ...props.style,
      }}
    />
  );
}

/** Card skeleton for dashboard stat cards */
export function SkeletonCard(props: { height?: string }) {
  return (
    <div class="skeleton-card" style={{ height: props.height || "120px" }}>
      <div class="skeleton-line skeleton-line-short" />
      <div class="skeleton-line" />
      <div class="skeleton-line skeleton-line-medium" />
    </div>
  );
}

const COL_WIDTHS = ["65%", "55%", "72%", "48%", "60%", "80%", "45%"];

/** Row skeleton for tables — supports variable column count */
export function SkeletonRow(props: { columns?: number }) {
  const items = () => Array.from({ length: props.columns || 5 }, (_, i) => i);
  return (
    <tr class="skeleton-row">
      <Index each={items()}>
        {(i) => (
          <td style={{ padding: "12px 8px" }}>
            <div class="skeleton-line" style={{ width: COL_WIDTHS[i() % COL_WIDTHS.length], height: "14px" }} />
          </td>
        )}
      </Index>
    </tr>
  );
}
