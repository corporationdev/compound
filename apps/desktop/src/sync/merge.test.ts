import { describe, expect, it } from "vitest";

import { mergeText } from "./merge";

const base = ["a", "b", "c", "d", "e"].join("\n") + "\n";

describe("mergeText", () => {
  it("returns the other side when one side is unchanged", () => {
    expect(mergeText(base, base, "x\n")).toEqual({ text: "x\n", conflicted: false });
    expect(mergeText(base, "x\n", base)).toEqual({ text: "x\n", conflicted: false });
  });

  it("combines edits to different lines", () => {
    const local = base.replace("a", "A");
    const remote = base.replace("e", "E");
    expect(mergeText(base, local, remote)).toEqual({ text: base.replace("a", "A").replace("e", "E"), conflicted: false });
  });

  it("combines an insert on one side with a delete on the other", () => {
    const local = "a\nb\nb2\nc\nd\ne\n";
    const remote = "a\nb\nc\ne\n";
    expect(mergeText(base, local, remote)).toEqual({ text: "a\nb\nb2\nc\ne\n", conflicted: false });
  });

  it("keeps the local side where both changed the same lines and says so", () => {
    const local = base.replace("c", "local");
    const remote = base.replace("c", "remote");
    expect(mergeText(base, local, remote)).toEqual({ text: local, conflicted: true });
  });

  it("does not call the same change on both sides a conflict", () => {
    const both = base.replace("c", "same");
    expect(mergeText(base, both, both)).toEqual({ text: both, conflicted: false });
  });

  it("merges against an empty base when two clients created the same file", () => {
    const merged = mergeText("", "one\n", "two\n");
    expect(merged.conflicted).toBe(true);
    expect(merged.text).toBe("one\n");
  });

  it("preserves a missing trailing newline", () => {
    expect(mergeText("a\nb\nc", "a\nb\nC", "A\nb\nc")).toEqual({ text: "A\nb\nC", conflicted: false });
  });

  it("treats edits to adjacent lines as one region, like diff3 does", () => {
    expect(mergeText("a\nb", "a\nB", "A\nb").conflicted).toBe(true);
  });
});
