import { useWorld } from "@compound/koota-solid";
import { getRuntimeDocument } from "@compound/reconciler";

export function useDocument() {
  const world = useWorld();
  return () => getRuntimeDocument(world);
}
