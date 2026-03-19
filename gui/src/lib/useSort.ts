import { createSignal } from "solid-js";

export function useSort<T>(defaultField: string, defaultDir: "asc" | "desc" = "asc") {
  const [sortField, setSortField] = createSignal(defaultField);
  const [sortDir, setSortDir] = createSignal<"asc" | "desc">(defaultDir);

  const toggleSort = (field: string) => {
    if (sortField() === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sortFn = (items: T[], getField: (item: T, field: string) => any): T[] => {
    const field = sortField();
    const dir = sortDir();
    return [...items].sort((a, b) => {
      let va = getField(a, field);
      let vb = getField(b, field);
      // Handle strings case-insensitively
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      // Handle nulls
      if (va == null) return 1;
      if (vb == null) return -1;
      // Compare
      if (va < vb) return dir === "asc" ? -1 : 1;
      if (va > vb) return dir === "asc" ? 1 : -1;
      return 0;
    });
  };

  return { sortField, sortDir, toggleSort, sortFn };
}
