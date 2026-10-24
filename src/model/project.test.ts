import { describe, expect, it } from "bun:test";
import { emptyProject, parseProject, rawDuration } from "./project";

describe("parseProject", () => {
  it("fills every default from an id", () => {
    const res = parseProject({ id: "p1" });
    if (!res.ok) throw new Error(res.error);
    const p = res.project;
    expect(p.title).toBe("Untitled video");
    expect(p.style.aspect).toBe("16:9");
    expect(p.style.bubble.corner).toBe("bottom-right");
    expect(p.style.captions.enabled).toBe(false);
    expect(p.style.audio.denoise).toBe(true);
    expect(p.clips).toEqual([]);
  });

  it("fills a clip's sources and says where a project is wrong", () => {
    const res = parseProject({
      id: "p1",
      clips: [{ id: "c1", duration: 4, screen: { key: "c1-screen", type: "video/webm" } }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.project.clips[0]?.screen?.offset).toBe(0);
    expect(res.project.clips[0]?.camera).toBeNull();
    expect(rawDuration(res.project)).toBe(4);
    const bad = parseProject({ id: "p1", clips: [{ id: "c1" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("clips.0.duration");
  });

  it("makes empty projects with fresh ids", () => {
    expect(emptyProject().id).not.toBe(emptyProject().id);
    expect(emptyProject("Demo").title).toBe("Demo");
  });
});
