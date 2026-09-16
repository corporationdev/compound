/** Apply a checkbox selection, with ranges measured in the current visible order. */
export function selectDatabaseRows(current: ReadonlySet<string>, visible: string[], target: string, anchor: string | null, range: boolean): Set<string> {
  const next = new Set(current);
  const selected = !next.has(target);
  const start = anchor === null ? -1 : visible.indexOf(anchor);
  const end = visible.indexOf(target);
  const paths = range && start >= 0 && end >= 0 ? visible.slice(Math.min(start, end), Math.max(start, end) + 1) : [target];
  for (const path of paths) {
    if (selected) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** Natural text order and true numeric order, including columns with empty cells. */
export function compareDatabaseValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null || left === "") return -1;
  if (right === undefined || right === null || right === "") return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/** Keep optimistic insertions in the same order as later filesystem snapshots. */
export function compareDatabaseRows(left: { name: string; path: string }, right: { name: string; path: string }): number {
  return compareDatabaseValues(left.name, right.name) || left.path.localeCompare(right.path);
}

/** Serialize read-modify-write operations per file; different files remain independent. */
export function createFileQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    const next = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(path, next);
    void next.finally(() => {
      if (pending.get(path) === next) pending.delete(path);
    }).catch(() => {});
    return next;
  };
}
