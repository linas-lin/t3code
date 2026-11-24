import { describe, expect, it } from "vite-plus/test";

import { classifyChangeKind, computeConnectorBands } from "./connectorGeometry.logic";

describe("connectorGeometry.logic", () => {
  it("classifies added, deleted, and modified changes using Monaco line change conventions", () => {
    expect(
      classifyChangeKind({
        originalStartLineNumber: 5,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 6,
        modifiedEndLineNumber: 8,
      }),
    ).toBe("added");

    expect(
      classifyChangeKind({
        originalStartLineNumber: 10,
        originalEndLineNumber: 12,
        modifiedStartLineNumber: 9,
        modifiedEndLineNumber: 0,
      }),
    ).toBe("deleted");

    expect(
      classifyChangeKind({
        originalStartLineNumber: 2,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 5,
      }),
    ).toBe("modified");
  });

  it("computes SVG cubic bezier connector paths and culls offscreen bands", () => {
    const lineHeight = 20;
    const bands = computeConnectorBands({
      width: 24,
      height: 300,
      lineHeight,
      activeIndex: 0,
      getOriginalTop: (line) => (line - 1) * lineHeight,
      getModifiedTop: (line) => (line - 1) * lineHeight,
      changes: [
        {
          originalStartLineNumber: 2,
          originalEndLineNumber: 3,
          modifiedStartLineNumber: 2,
          modifiedEndLineNumber: 5,
        },
        {
          originalStartLineNumber: 50,
          originalEndLineNumber: 52,
          modifiedStartLineNumber: 52,
          modifiedEndLineNumber: 53,
        },
      ],
    });

    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      index: 0,
      kind: "modified",
      isActive: true,
      leftTop: 20,
      leftBottom: 60,
      rightTop: 20,
      rightBottom: 100,
    });
    expect(bands[0]?.pathD).toContain("M 0 20");
    expect(bands[0]?.pathD).toContain("C 12 20, 12 20, 24 20");
    expect(bands[0]?.pathD).toContain("L 24 100");
  });
});
