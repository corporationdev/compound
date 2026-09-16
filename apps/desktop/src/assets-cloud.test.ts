/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pure parts of moving originals: where a fetched one lands and what
// the main process refuses before it talks to the server.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { extensionOf, originalCachePath, uploadAssetOriginal, fetchAssetOriginal, validSampleId } = await import("./assets-cloud");

describe("originals cache paths", () => {
  it("keeps the cloud name's extension and names the file by its sample id", () => {
    expect(originalCachePath("/p", "0123456789abcdef", "Clip Final.MOV")).toBe(join("/p", "cache", "originals", "0123456789abcdef.mov"));
    expect(originalCachePath("/p", "0123456789abcdef", "noext")).toBe(join("/p", "cache", "originals", "0123456789abcdef"));
  });

  it("takes only a well-formed sample id into a path", () => {
    expect(validSampleId("0123456789abcdef")).toBe(true);
    expect(validSampleId("../0123456789abcd")).toBe(false);
    expect(validSampleId("0123456789ABCDEF")).toBe(false);
    expect(() => originalCachePath("/p", "../../etc", "x.mp4")).toThrow("Invalid asset id");
  });

  it("reads an extension only when it looks like one", () => {
    expect(extensionOf("a.mp4")).toBe(".mp4");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
    expect(extensionOf("weird.ex t")).toBe("");
    expect(extensionOf("dir.v1/name")).toBe("");
  });
});

describe("refusals before any request", () => {
  const token = "jwt";
  it("refuses a malformed id, a relative source, and a source that is not there", async () => {
    await expect(uploadAssetOriginal({ dir: "/p", organizationId: "x", sampleId: "nope", source: "/p/a.mp4", mimeType: "video/mp4", name: "a.mp4", token })).rejects.toThrow("Invalid asset id");
    await expect(uploadAssetOriginal({ dir: "/p", organizationId: "x", sampleId: "0123456789abcdef", source: "assets/a.mp4", mimeType: "video/mp4", name: "a.mp4", token })).rejects.toThrow("absolute");
    await expect(uploadAssetOriginal({ dir: "/p", organizationId: "x", sampleId: "0123456789abcdef", source: join(tmpdir(), "does-not-exist-" + Date.now()), mimeType: "video/mp4", name: "a.mp4", token })).rejects.toThrow("No such file");
    await expect(fetchAssetOriginal({ dir: "/p", organizationId: "x", sampleId: "0123456789abcdeg", token })).rejects.toThrow("Invalid asset id");
  });
});
