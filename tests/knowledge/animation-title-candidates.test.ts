import { describe, expect, it } from "vitest";
import { animationTitleCandidatesForTest } from "../../src/knowledge/creature-animation-importer.js";

const candidates = (name: string) =>
  animationTitleCandidatesForTest({ catalogId: 1, race: "x", name, officialImageUrl: null });

describe("animationTitleCandidates", () => {
  it("offers the sentence-case singular the wiki actually stores", () => {
    // MediaWiki only normalises the first character, so "Of The" never matches
    // the real "Acolyte of the Cult.gif".
    expect(candidates("Acolytes Of The Cult")).toContain("Acolyte of the Cult.gif");
    expect(candidates("Adepts Of The Cult")).toContain("Adept of the Cult.gif");
  });

  it("still offers the untouched name", () => {
    expect(candidates("Dragons")).toContain("Dragons.gif");
  });

  it("handles the irregular plurals the catalog uses", () => {
    expect(candidates("Winter Wolves")).toContain("Winter Wolf.gif");
    expect(candidates("Butterflies")).toContain("Butterfly.gif");
    expect(candidates("Hideous Fungi")).toContain("Hideous Fungus.gif");
    expect(candidates("Courage Leeches")).toContain("Courage Leech.gif");
    expect(candidates("Crape Men")).toContain("Crape Man.gif");
    expect(candidates("Sabreteeth")).toContain("Sabretooth.gif");
    expect(candidates("Misguided Thieves")).toContain("Misguided Thief.gif");
  });

  it("singularises the head noun, not only the tail", () => {
    // The old rule only stripped a trailing "s" from the whole string, so a plural
    // sitting in the first word was never undone.
    expect(candidates("Boar Men")).toContain("Boar Man.gif");
    expect(candidates("Cyclopes Drone")).toContain("Cyclope Drone.gif");
  });

  it("leaves singular names alone", () => {
    expect(candidates("Fish")).toContain("Fish.gif");
    expect(candidates("Cloak of Terror")).toContain("Cloak of Terror.gif");
  });

  it("never emits duplicates", () => {
    const list = candidates("Dragon");
    expect(new Set(list).size).toBe(list.length);
  });

  it("takes the filename from mid-path, not the /revision/latest tail", () => {
    expect(animationTitleCandidatesForTest({
      catalogId: 1,
      race: "x",
      name: "Whatever",
      officialImageUrl: "https://static.wikia.nocookie.net/tibia/images/7/75/Acid_Blob.gif/revision/latest"
    })).toContain("Acid_Blob.gif");
  });
});
