import { describe, expect, it } from "bun:test";
import { parseRoute } from "./router";

describe("parseRoute", () => {
  it("reads every page", () => {
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/record")).toEqual({ name: "record", project: null });
    expect(parseRoute("#/record?project=p1")).toEqual({ name: "record", project: "p1" });
    expect(parseRoute("#/edit/p1")).toEqual({ name: "edit", id: "p1" });
    expect(parseRoute("#/watch/abc.def")).toEqual({ name: "watch", room: "abc.def" });
  });

  it("falls back to home", () => {
    expect(parseRoute("#/edit")).toEqual({ name: "home" });
    expect(parseRoute("#/nowhere")).toEqual({ name: "home" });
  });
});
