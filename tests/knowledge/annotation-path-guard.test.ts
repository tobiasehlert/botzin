import { describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { inside } from "../../scripts/path-inside.js";

const uiRoot = resolve("annotation-ui");

describe("inside", () => {
  it("accepts descendants", () => {
    expect(inside(uiRoot, join(uiRoot, "index.html"))).toBe(true);
    expect(inside(uiRoot, join(uiRoot, "assets", "app.js"))).toBe(true);
  });

  it("rejects the parent itself, siblings and traversal", () => {
    expect(inside(uiRoot, uiRoot)).toBe(false);
    expect(inside(uiRoot, join(uiRoot, "..", "src", "index.ts"))).toBe(false);
    expect(inside(uiRoot, `${uiRoot}-other${sep}app.js`)).toBe(false);
  });
});
