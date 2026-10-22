// "Go to a page and open one of its dialogs", e.g. ⌘K → "Run a container".
// The page consumes the intent once, whether it was already open or not.

import { createEffect, createSignal } from "solid-js";

const [intent, setIntent] = createSignal<{ page: string; action: string; at: number } | null>(null);

export function requestIntent(page: string, action: string) {
  setIntent({ page, action, at: Date.now() });
}

/** In a page: run `handle` for every intent aimed at it. */
export function onIntent(page: string, handle: (action: string) => void) {
  createEffect(() => {
    const i = intent();
    if (i?.page !== page) return;
    setIntent(null);
    // One the page didn't pick up right away (the user went elsewhere) is stale.
    if (Date.now() - i.at < 10_000) handle(i.action);
  });
}
