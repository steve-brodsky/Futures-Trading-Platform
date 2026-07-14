import { describe, expect, it } from "vitest";
import { isTargetOutside, type TargetContainer } from "./menuFocus";

describe("menu focus containment", () => {
  const inside = { id: "inside" };
  const outside = { id: "outside" };
  const container: TargetContainer<object> = { contains: (target) => target === inside };

  it("keeps the menu open for pointer or focus targets inside it", () => {
    expect(isTargetOutside(container, inside)).toBe(false);
  });

  it("dismisses for outside targets or a missing menu container", () => {
    expect(isTargetOutside(container, outside)).toBe(true);
    expect(isTargetOutside(null, inside)).toBe(true);
  });
});
