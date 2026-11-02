import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getMedia, mediaWriter, migrateMedia, sweepOrphanMedia } from "./store";

// A small in-memory Origin Private File System: directories, files, move().
type Node = FakeDir | FakeFile;

class FakeFile {
  readonly kind = "file";
  data: Blob = new Blob([]);
  lastModified = Date.now();
  failWrites = false;
  constructor(
    public name: string,
    public parent: FakeDir,
    public movable = true,
  ) {}
  async getFile(): Promise<File> {
    return new File([this.data], this.name, { lastModified: this.lastModified });
  }
  get move(): ((dir: FakeDir) => Promise<void>) | undefined {
    if (!this.movable) return undefined;
    return async (dir: FakeDir) => {
      this.parent.children.delete(this.name);
      this.parent = dir;
      dir.children.set(this.name, this);
    };
  }
  async createWritable() {
    if (this.parent.failOpen) throw new DOMException("full", "QuotaExceededError");
    const parts: Blob[] = [];
    return {
      write: async (b: Blob) => {
        if (this.failWrites) throw new DOMException("full", "QuotaExceededError");
        parts.push(b);
      },
      close: async () => {
        this.data = new Blob(parts);
      },
      abort: async () => {
        parts.length = 0;
      },
    };
  }
}

class FakeDir {
  readonly kind = "directory";
  children = new Map<string, Node>();
  failOpen = false;
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    if (c || !o?.create) throw new DOMException(name, c ? "TypeMismatchError" : "NotFoundError");
    const d = new FakeDir(name);
    d.failOpen = this.failOpen;
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FakeFile> {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return c;
    if (c || !o?.create) throw new DOMException(name, c ? "TypeMismatchError" : "NotFoundError");
    const f = new FakeFile(name, this);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string, o?: { recursive?: boolean }): Promise<void> {
    const c = this.children.get(name);
    if (!c) throw new DOMException(name, "NotFoundError");
    if (c instanceof FakeDir && c.children.size && !o?.recursive)
      throw new DOMException(name, "InvalidModificationError");
    this.children.delete(name);
  }
  async *keys() {
    for (const k of [...this.children.keys()]) yield k;
  }
  async *values() {
    for (const v of [...this.children.values()]) yield v;
  }
  async *entries() {
    for (const e of [...this.children.entries()]) yield e;
  }
}

let root: FakeDir;
const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "storage");

beforeEach(() => {
  root = new FakeDir("");
  Object.defineProperty(globalThis.navigator, "storage", {
    value: { getDirectory: async () => root },
    configurable: true,
  });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis.navigator, "storage", original);
  else delete (globalThis.navigator as { storage?: unknown }).storage;
});

async function put(path: string[], text: string, movable = true): Promise<FakeFile> {
  let d = root;
  for (const p of path.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const name = path.at(-1) ?? "";
  const f = new FakeFile(name, d, movable);
  f.data = new Blob([text]);
  d.children.set(name, f);
  return f;
}

const at = (...path: string[]) =>
  path.reduce<Node | undefined>(
    (n, p) => (n instanceof FakeDir ? n.children.get(p) : undefined),
    root,
  );

describe("media on an origin shared by several sites", () => {
  it("moves our projects' files out of the root's generic projects/ folder", async () => {
    await put(["projects", "p1", "c1-screen"], "screen");
    await put(["projects", "p1", "c1-poster"], "poster");
    await put(["projects", "elsewhere", "x"], "another site's");
    await migrateMedia(["p1"]);
    expect(at("takeone", "projects", "p1", "c1-screen")).toBeInstanceOf(FakeFile);
    expect(at("takeone", "projects", "p1", "c1-poster")).toBeInstanceOf(FakeFile);
    // Our emptied folder goes; another site's folder and projects/ itself stay.
    expect(at("projects", "p1")).toBeUndefined();
    expect(at("projects", "elsewhere", "x")).toBeInstanceOf(FakeFile);
    expect(at("projects")).toBeInstanceOf(FakeDir);
    expect(await (await getMedia("p1", "c1-screen"))?.text()).toBe("screen");
    // Again: nothing left to move, nothing breaks.
    await migrateMedia(["p1"]);
    expect(at("takeone", "projects", "p1", "c1-screen")).toBeInstanceOf(FakeFile);
  });

  it("still reads a file that could not move from where it was", async () => {
    await put(["projects", "p1", "c1-mic"], "voice", false);
    await migrateMedia(["p1"]);
    expect(at("projects", "p1", "c1-mic")).toBeInstanceOf(FakeFile);
    expect(await (await getMedia("p1", "c1-mic", "audio/webm"))?.text()).toBe("voice");
  });

  it("removes the files of takes no project kept, once they are a day old", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    (await put(["takeone", "projects", "gone", "c1-screen"], "x")).lastModified = now - 2 * day;
    (await put(["takeone", "projects", "recording", "c2-screen"], "x")).lastModified = now - 60_000;
    (await put(["takeone", "projects", "kept", "c3-screen"], "x")).lastModified = now - 30 * day;
    await sweepOrphanMedia(["kept"], now);
    expect(at("takeone", "projects", "gone")).toBeUndefined();
    expect(at("takeone", "projects", "recording")).toBeInstanceOf(FakeDir);
    expect(at("takeone", "projects", "kept")).toBeInstanceOf(FakeDir);
  });

  it("leaves no empty file behind when the storage refuses to open one", async () => {
    const projects = await (
      await root.getDirectoryHandle("takeone", { create: true })
    ).getDirectoryHandle("projects", { create: true });
    projects.failOpen = true;
    await expect(mediaWriter("p1", "c1-screen")).rejects.toThrow();
    expect(at("takeone", "projects", "p1", "c1-screen")).toBeUndefined();
  });

  it("lets go of a file whose writes failed", async () => {
    const writer = await mediaWriter("p1", "c1-screen");
    const file = at("takeone", "projects", "p1", "c1-screen") as FakeFile;
    file.failWrites = true;
    void writer.write(new Blob(["chunk"])).catch(() => undefined);
    await expect(writer.close("video/webm")).rejects.toThrow();
  });
});
