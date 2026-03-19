/** Skeleton loading placeholder — renders pulsing gray blocks */
export function SkeletonCard(props: { height?: string }) {
  return (
    <div class="skeleton-card" style={{ height: props.height || "120px" }}>
      <div class="skeleton-line skeleton-line-short" />
      <div class="skeleton-line" />
      <div class="skeleton-line skeleton-line-medium" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <tr class="skeleton-row">
      <td><div class="skeleton-line skeleton-line-short" /></td>
      <td><div class="skeleton-line" /></td>
      <td><div class="skeleton-line skeleton-line-medium" /></td>
      <td><div class="skeleton-line skeleton-line-short" /></td>
    </tr>
  );
}
