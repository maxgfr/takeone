import { describe, expect, it } from "bun:test";
import { parseProject, type VoiceoverPiece } from "../model/project";
import { segmentsOf } from "./timeline";
import {
  layPieces,
  pieceAt,
  placeWords,
  unusedFiles,
  voiceoverPieces,
  voiceParts,
} from "./voiceover";

function project(cuts: { clip: string; start: number; end: number }[] = []) {
  const res = parseProject({
    id: "p",
    clips: [
      { id: "a", duration: 10, mic: { key: "a-mic", type: "audio/webm", offset: 0.2 } },
      { id: "b", duration: 6 },
    ],
    cuts: cuts.map((c, i) => ({ id: `x${i}`, ...c })),
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

const file = { key: "vo1", type: "audio/webm" };
const piece = (start: number, end: number, at: number, key = "vo1"): VoiceoverPiece => ({
  key,
  type: "audio/webm",
  start,
  end,
  at,
});

describe("voiceoverPieces", () => {
  it("lays the file on the ranges of the takes that were playing", () => {
    // Take a keeps 0–2 and 5–10 (7 s), then take b's 6 s.
    const segs = segmentsOf(project([{ clip: "a", start: 2, end: 5 }]));
    const placed = voiceoverPieces(segs, 1, 9, 0.1, file);
    expect(placed).toEqual([
      { clip: "a", piece: piece(1, 2, 0.1) },
      { clip: "a", piece: piece(5, 10, 1.1) },
      { clip: "b", piece: { ...piece(0, 2, 6.1) } },
    ]);
  });

  it("drops slivers", () => {
    const segs = segmentsOf(project());
    expect(voiceoverPieces(segs, 0, 0.01, 0, file)).toEqual([]);
  });
});

describe("layPieces", () => {
  it("lets a new recording replace only the passage it covers", () => {
    const old = [piece(0, 10, 0, "old")];
    const laid = layPieces(old, [piece(3, 5, 0.2, "new")]);
    expect(laid).toEqual([piece(0, 3, 0, "old"), piece(3, 5, 0.2, "new"), piece(5, 10, 5, "old")]);
    expect(pieceAt(laid, 4)?.key).toBe("new");
    expect(pieceAt(laid, 6)?.key).toBe("old");
    expect(pieceAt(laid, 11)).toBeUndefined();
  });
});

describe("placeWords", () => {
  it("moves words from the file's clock to the take's, leaving out what no piece keeps", () => {
    const pieces = [piece(5, 10, 1)];
    const words = [
      { text: "before", start: 0.2, end: 0.6 },
      { text: "hello", start: 1.5, end: 2 },
      { text: "after", start: 6.5, end: 7 },
    ];
    expect(placeWords(words, pieces)).toEqual([{ text: "hello", start: 5.5, end: 6 }]);
  });
});

describe("voiceParts", () => {
  it("is the microphone from where it opened, the voice-over, or nothing", () => {
    const [a] = project().clips;
    if (!a) throw new Error("no clip");
    expect(voiceParts(a)).toEqual([
      { key: "a-mic", type: "audio/webm", start: 0.2, end: Number.POSITIVE_INFINITY, at: 0 },
    ]);
    expect(voiceParts({ ...a, voice: "none" })).toEqual([]);
    const over = { pieces: [piece(0, 3, 0)], transcript: null };
    expect(voiceParts({ ...a, voice: "over", voiceover: over })).toEqual(over.pieces);
  });
});

describe("unusedFiles", () => {
  it("names the files no take plays any more", () => {
    const p = project();
    const clips = p.clips.map((c) =>
      c.id === "a"
        ? { ...c, voiceover: { pieces: [piece(0, 1, 0, "kept")], transcript: null } }
        : c,
    );
    expect(unusedFiles({ ...p, clips }, ["kept", "gone", "gone"])).toEqual(["gone"]);
  });
});
