import { For } from "solid-js";

interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export default function Breadcrumb(props: BreadcrumbProps) {
  return (
    <nav class="breadcrumb">
      <For each={props.items}>
        {(item, index) => {
          const isLast = () => index() === props.items.length - 1;
          return (
            <>
              {isLast() ? (
                <span class="breadcrumb-current">{item.label}</span>
              ) : (
                <>
                  <button class="breadcrumb-item" onClick={() => item.onClick?.()}>
                    {item.label}
                  </button>
                  <span class="breadcrumb-separator">{"\u203A"}</span>
                </>
              )}
            </>
          );
        }}
      </For>
    </nav>
  );
}
