interface ResourceBarProps {
  value: number;     // percentage 0-100
  label?: string;
  size?: "sm" | "md";
  showLabel?: boolean;
}

export default function ResourceBar(props: ResourceBarProps) {
  const size = () => props.size || "sm";
  const clamped = () => Math.max(0, Math.min(100, props.value));

  const colorClass = () => {
    const v = clamped();
    if (v > 80) return "resource-bar-fill-red";
    if (v > 50) return "resource-bar-fill-yellow";
    return "resource-bar-fill-green";
  };

  return (
    <div class="inline-resource">
      <div class={`resource-bar ${size() === "md" ? "resource-bar-md" : ""}`}>
        <div
          class={`resource-bar-fill ${colorClass()}`}
          style={{ width: `${clamped()}%` }}
        />
      </div>
      {props.showLabel !== false && props.label && (
        <span class="resource-bar-label">{props.label}</span>
      )}
    </div>
  );
}
