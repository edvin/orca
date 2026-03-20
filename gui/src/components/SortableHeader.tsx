import { JSX, Show } from "solid-js";

interface SortableHeaderProps {
  label: string;
  field: string;
  currentSort: string;
  currentDirection: "asc" | "desc";
  onSort: (field: string) => void;
  align?: "left" | "right";
  style?: JSX.CSSProperties;
}

export default function SortableHeader(props: SortableHeaderProps) {
  const isActive = () => props.currentSort === props.field;

  return (
    <th
      class="sortable-th"
      style={{ "text-align": props.align || "left", cursor: "pointer", ...props.style }}
      onClick={() => props.onSort(props.field)}
    >
      {props.label}
      <Show when={isActive()}>
        <span class="sort-indicator">
          {props.currentDirection === "asc" ? " \u25B2" : " \u25BC"}
        </span>
      </Show>
    </th>
  );
}
