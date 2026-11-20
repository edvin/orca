import { For } from "solid-js";
import { t } from "../lib/i18n";

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
                <span class="breadcrumb-current">{t(item.label)}</span>
              ) : (
                <>
                  <button class="breadcrumb-item" onClick={() => item.onClick?.()}>
                    {t(item.label)}
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
