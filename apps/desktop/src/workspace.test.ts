// The workspace folder: finding or making it for an organization, moving
// legacy projects into it, listing it, and the file operations the
// renderer's tree and editor go through.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trashed: string[] = [];
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: { trashItem: async (path: string) => { trashed.push(path); } },
  ipcMain: { on: () => { } },
}));

const {
  createWorkspaceEntry,
  findProjects,
  isVisiblePath,
  listWorkspace,
  openWorkspace,
  readWorkspaceFile,
  removeWorkspaceEntry,
  renameWorkspaceEntry,
  workspacePath,
  writeWorkspaceFile,
} = await import("./workspace");
const { initProject } = await import("./projects");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-test-"));
  trashed.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ORG = { root: "", organizationId: "org_1", name: "Acme Studio" };

describe("openWorkspace", () => {
  it("makes a folder named after the organization with a starter projects folder, and finds it again", async () => {
    const first = await openWorkspace({ ...ORG, root });
    expect(first).toEqual({ dir: join(root, "Acme Studio"), organizationId: "org_1", created: true, moved: [] });
    expect((await stat(join(first.dir, "projects"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(first.dir, ".compound", "workspace.json"), "utf8"))).toEqual({ organizationId: "org_1" });

    const again = await openWorkspace({ ...ORG, root, name: "Renamed Org" });
    expect(again).toEqual({ dir: first.dir, organizationId: "org_1", created: false, moved: [] });
  });

  it("numbers the folder when another organization already has the name", async () => {
    const a = await openWorkspace({ ...ORG, root });
    const b = await openWorkspace({ ...ORG, root, organizationId: "org_2" });
    expect(a.dir).toBe(join(root, "Acme Studio"));
    expect(b.dir).toBe(join(root, "Acme Studio-2"));
    expect((await openWorkspace({ ...ORG, root, organizationId: "org_2" })).dir).toBe(b.dir);
  });

  it("moves legacy project folders from the root into projects/ and drops their cloud binding", async () => {
    const film = join(root, "wild-storm");
    await initProject(null, film);
    const pkg = JSON.parse(await readFile(join(film, "package.json"), "utf8"));
    await writeFile(join(film, "package.json"), JSON.stringify({ ...pkg, cloudProjectId: "proj_1" }, null, 2));
    await mkdir(join(root, "not-a-project"));
    await writeFile(join(root, "stray.txt"), "x");

    const opened = await openWorkspace({ ...ORG, root });
    const moved = join(opened.dir, "projects", "wild-storm");
    expect(opened.moved).toEqual([{ from: film, to: moved }]);
    expect((await stat(join(moved, "index.tsx"))).isFile()).toBe(true);
    expect("cloudProjectId" in JSON.parse(await readFile(join(moved, "package.json"), "utf8"))).toBe(false);
    await expect(stat(film)).rejects.toThrow();
    expect((await stat(join(root, "not-a-project"))).isDirectory()).toBe(true);
    // Another organization's workspace later on finds nothing left to move.
    expect((await openWorkspace({ ...ORG, root, organizationId: "org_2", name: "Other" })).moved).toEqual([]);
  });
});

describe("listWorkspace and findProjects", () => {
  it("lists visible entries depth first, marks projects, and skips ignored and hidden names", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    await initProject(null, join(dir, "projects", "film"));
    await mkdir(join(dir, "projects", "film", "node_modules", "x"), { recursive: true });
    await mkdir(join(dir, "projects", "film", "cache"), { recursive: true });
    await writeFile(join(dir, "projects", "film", "cache", "a.bin"), "x");
    await writeFile(join(dir, "notes.md"), "# Notes\n");
    await writeFile(join(dir, ".hidden"), "x");
    await mkdir(join(dir, "ideas"));
    await writeFile(join(dir, "ideas", "Hook 2.md"), "");
    await writeFile(join(dir, "ideas", "Hook 10.md"), "");

    const entries = await listWorkspace(dir);
    expect(entries.map((entry) => [entry.path, entry.kind, entry.project ?? null])).toEqual([
      ["ideas", "directory", false],
      ["ideas/Hook 2.md", "file", null],
      ["ideas/Hook 10.md", "file", null],
      ["notes.md", "file", null],
      ["projects", "directory", false],
      ["projects/film", "directory", true],
      ["projects/film/index.tsx", "file", null],
      ["projects/film/package.json", "file", null],
    ]);

    const projects = await findProjects(dir);
    expect(projects.map((project) => project.dir)).toEqual([join(dir, "projects", "film")]);
  });

  it("finds projects at any depth", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    await initProject(null, join(dir, "clients", "acme", "launch"));
    await initProject(null, join(dir, "projects", "top"));
    expect((await findProjects(dir)).map((project) => project.name).sort()).toEqual(["launch", "top"]);
  });
});

describe("paths", () => {
  it("resolves inside the workspace and refuses escapes", () => {
    expect(workspacePath("/ws", "a/b.md")).toBe("/ws/a/b.md");
    expect(() => workspacePath("/ws", "../b.md")).toThrow();
    expect(() => workspacePath("/ws", "a/../../b.md")).toThrow();
    expect(() => workspacePath("/ws", "a\\b.md")).toThrow();
    expect(workspacePath("/ws", "")).toBe("/ws");
  });

  it("hides dotfiles, ignored names and temp files", () => {
    expect(isVisiblePath("notes.md")).toBe(true);
    expect(isVisiblePath("projects/film/index.tsx")).toBe(true);
    expect(isVisiblePath(".compound/sync/state.json")).toBe(false);
    expect(isVisiblePath("projects/film/node_modules/x")).toBe(false);
    expect(isVisiblePath("projects/film/.dstmp-index.tsx.1")).toBe(false);
    expect(isVisiblePath("a/.hidden")).toBe(false);
  });
});

describe("file operations", () => {
  it("reads text, reports binary, and returns null for nothing", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    await writeFile(join(dir, "notes.md"), "hello");
    await writeFile(join(dir, "blob.bin"), new Uint8Array([1, 0, 2]));
    expect(await readWorkspaceFile(dir, "notes.md")).toMatchObject({ kind: "text", text: "hello" });
    expect(await readWorkspaceFile(dir, "blob.bin")).toMatchObject({ kind: "binary", size: 3 });
    expect(await readWorkspaceFile(dir, "missing.md")).toBeNull();
    expect(await readWorkspaceFile(dir, "projects")).toBeNull();
  });

  it("writes text, creating folders on the way", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    expect(await writeWorkspaceFile(dir, "ideas/hook.md", "---\ntitle: Hook\n---\n\nBody\n")).toEqual({ status: "ok" });
    expect(await readFile(join(dir, "ideas", "hook.md"), "utf8")).toBe("---\ntitle: Hook\n---\n\nBody\n");
  });

  it("merges against the base when the file moved on since the caller read it", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    const base = "a\nb\nc\nd\ne\n";
    await writeFile(join(dir, "notes.md"), base);
    // Unchanged on disk: the caller's text lands as is.
    expect(await writeWorkspaceFile(dir, "notes.md", base.replace("a", "A"), base)).toEqual({ status: "ok" });
    // An agent changed a different line meanwhile: both edits land.
    await writeFile(join(dir, "notes.md"), base.replace("A", "a").replace("e", "E"));
    const merged = await writeWorkspaceFile(dir, "notes.md", base.replace("a", "A"), base);
    expect(merged).toEqual({ status: "merged", text: "A\nb\nc\nd\nE\n", conflicted: false });
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("A\nb\nc\nd\nE\n");
    // The same line on both sides: the caller's wins, and the result says so.
    await writeFile(join(dir, "notes.md"), "A\nb\nc\nd\nE\n".replace("c", "theirs"));
    const clash = await writeWorkspaceFile(dir, "notes.md", "A\nb\nmine\nd\nE\n", "A\nb\nc\nd\nE\n");
    expect(clash).toEqual({ status: "merged", text: "A\nb\nmine\nd\nE\n", conflicted: true });
    // A base of null means "new file": an existing file is merged against nothing, so its text is kept beside the caller's.
    expect((await writeWorkspaceFile(dir, "notes.md", "fresh\n", null)).status).toBe("merged");
  });

  it("creates files and folders, numbering taken names", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    expect(await createWorkspaceEntry(dir, "Untitled.md", "file")).toBe("Untitled.md");
    expect(await createWorkspaceEntry(dir, "Untitled.md", "file")).toBe("Untitled 2.md");
    expect(await createWorkspaceEntry(dir, "Untitled.md", "file")).toBe("Untitled 3.md");
    expect(await createWorkspaceEntry(dir, "ideas", "directory")).toBe("ideas");
    expect(await createWorkspaceEntry(dir, "ideas", "directory")).toBe("ideas 2");
    expect(await createWorkspaceEntry(dir, "ideas/New folder", "directory")).toBe("ideas/New folder");
    expect((await stat(join(dir, "ideas 2"))).isDirectory()).toBe(true);
  });

  it("merges frontmatter edits on different lines without losing either", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    const base = "---\nstatus: Idea\nplatform:\n  - youtube\nviews: 1200\nready: false\n---\n\nBody line.\n";
    await writeFile(join(dir, "page.md"), base);
    // An agent flips `ready` on disk while the page changes `status`.
    await writeFile(join(dir, "page.md"), base.replace("ready: false", "ready: true"));
    const result = await writeWorkspaceFile(dir, "page.md", base.replace("status: Idea", "status: Filming"), base);
    expect(result).toEqual({ status: "merged", text: base.replace("status: Idea", "status: Filming").replace("ready: false", "ready: true"), conflicted: false });
    // Adjacent lines on both sides: the caller's line wins, everything else stays.
    const second = (result as { text: string }).text;
    await writeFile(join(dir, "page.md"), second.replace("views: 1200", "views: 1500"));
    const clash = await writeWorkspaceFile(dir, "page.md", second.replace("views: 1200", "views: 1300").replace("Body line.", "Body line, edited."), second);
    expect(clash.status).toBe("merged");
    const text = (clash as { text: string }).text;
    expect(text).toContain("status: Filming");
    expect(text).toContain("platform:\n  - youtube");
    expect(text).toContain("ready: true");
    expect(text).toContain("Body line, edited.");
    expect(text).toMatch(/views: 1[35]00/);
  });

  it("renames within the workspace, allows a change of case, and refuses to overwrite", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    await writeFile(join(dir, "a.md"), "a");
    await writeFile(join(dir, "b.md"), "b");
    await renameWorkspaceEntry(dir, "a.md", "ideas/c.md");
    expect(await readFile(join(dir, "ideas", "c.md"), "utf8")).toBe("a");
    await expect(renameWorkspaceEntry(dir, "ideas/c.md", "b.md")).rejects.toThrow("already exists");
    await expect(renameWorkspaceEntry(dir, "b.md", "../out.md")).rejects.toThrow();
    await expect(renameWorkspaceEntry(dir, "b.md", "")).rejects.toThrow("workspace itself");
    await renameWorkspaceEntry(dir, "b.md", "B.md");
    expect((await listWorkspace(dir)).map((entry) => entry.path)).toContain("B.md");
  });

  it("refuses a folder that was not opened as a workspace", async () => {
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "x.md"), "x");
    await expect(listWorkspace(join(root, "elsewhere"))).rejects.toThrow("Not an open workspace");
    await expect(readWorkspaceFile(join(root, "elsewhere"), "x.md")).rejects.toThrow("Not an open workspace");
    await expect(removeWorkspaceEntry(join(root, "elsewhere"), "x.md")).rejects.toThrow("Not an open workspace");
    expect(trashed).toEqual([]);
  });

  it("removes by moving to the trash, never the workspace itself", async () => {
    const { dir } = await openWorkspace({ ...ORG, root });
    await writeFile(join(dir, "a.md"), "a");
    await removeWorkspaceEntry(dir, "a.md");
    expect(trashed).toEqual([join(dir, "a.md")]);
    await expect(removeWorkspaceEntry(dir, "")).rejects.toThrow("workspace itself");
  });
});
