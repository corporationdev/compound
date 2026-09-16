import { describe, expect, it } from "vitest";

import { withProjectLock } from "./locks";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("withProjectLock", () => {
  it("serializes tasks on the same folder in order", async () => {
    const order: string[] = [];
    const a = withProjectLock("/tmp/ws", async () => {
      await sleep(20);
      order.push("a");
    });
    const b = withProjectLock("/tmp/ws", async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("a lock on a project waits for the workspace above it, and the other way round", async () => {
    const order: string[] = [];
    const workspace = withProjectLock("/tmp/ws", async () => {
      await sleep(20);
      order.push("workspace");
    });
    const project = withProjectLock("/tmp/ws/projects/film", async () => {
      order.push("project");
    });
    await Promise.all([workspace, project]);
    expect(order).toEqual(["workspace", "project"]);

    const later: string[] = [];
    const inner = withProjectLock("/tmp/ws/projects/film", async () => {
      await sleep(20);
      later.push("project");
    });
    const outer = withProjectLock("/tmp/ws", async () => {
      later.push("workspace");
    });
    await Promise.all([inner, outer]);
    expect(later).toEqual(["project", "workspace"]);
  });

  it("unrelated folders run concurrently", async () => {
    let overlap = false;
    let running = 0;
    const run = (dir: string) =>
      withProjectLock(dir, async () => {
        running++;
        await sleep(10);
        if (running > 1) overlap = true;
        running--;
      });
    await Promise.all([run("/tmp/a"), run("/tmp/b")]);
    expect(overlap).toBe(true);
  });

  it("a sibling that merely shares a prefix is unrelated", async () => {
    let overlap = false;
    let running = 0;
    const run = (dir: string) =>
      withProjectLock(dir, async () => {
        running++;
        await sleep(10);
        if (running > 1) overlap = true;
        running--;
      });
    await Promise.all([run("/tmp/ws"), run("/tmp/ws-other")]);
    expect(overlap).toBe(true);
  });

  it("releases the lock when a task throws", async () => {
    await expect(withProjectLock("/tmp/x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    let ran = false;
    await withProjectLock("/tmp/x", async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
