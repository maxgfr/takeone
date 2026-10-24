import { describe, expect, it } from "bun:test";
import { parseProject } from "../model/project";
import { outputChapters, outputWords, paragraphs, stamp, transcriptMarkdown } from "./text";

const w = (text: string, start: number, end: number) => ({ text, start, end });

function project() {
  const res = parseProject({
    id: "p",
    title: "Reports",
    clips: [
      {
        id: "a",
        duration: 10,
        transcript: {
          text: "",
          segments: [],
          words: [w("Open", 1, 1.3), w("um", 2, 2.3), w("reports.", 3, 3.5)],
          wordTimings: "exact",
        },
      },
      {
        id: "b",
        duration: 5,
        transcript: { text: "", segments: [], words: [w("Done.", 1, 1.4)], wordTimings: "exact" },
      },
    ],
    cuts: [{ id: "x", clip: "a", start: 1.9, end: 2.9 }],
    chapters: [
      { id: "c1", clip: "a", t: 0, title: "Start" },
      { id: "c2", clip: "a", t: 2.5, title: "Moved by the cut" },
      { id: "c3", clip: "b", t: 1, title: "End" },
    ],
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

describe("the edited video's words", () => {
  it("drops cut words and moves the rest up, across takes", () => {
    expect(outputWords(project())).toEqual([
      w("Open", 1, 1.3),
      { text: "reports.", start: 2, end: 2.5 },
      { text: "Done.", start: 10, end: 10.4 },
    ]);
  });

  it("moves chapters with the cuts", () => {
    expect(outputChapters(project())).toEqual([
      { t: 0, title: "Start" },
      { t: 1.9, title: "Moved by the cut" },
      { t: 10, title: "End" },
    ]);
  });

  it("writes Markdown with times", () => {
    expect(stamp(3725)).toBe("1:02:05");
    expect(paragraphs(outputWords(project()))).toHaveLength(2);
    const md = transcriptMarkdown(project());
    expect(md).toContain("# Reports");
    expect(md).toContain("- 0:01 Moved by the cut");
    expect(md).toContain("**0:01** Open reports.");
  });
});
