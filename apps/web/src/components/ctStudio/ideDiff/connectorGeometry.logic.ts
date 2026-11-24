import type { IdeDiffHunkChange } from "./types";

export type ConnectorBandKind = "added" | "deleted" | "modified";

export interface ConnectorBandGeometry {
  readonly index: number;
  readonly kind: ConnectorBandKind;
  readonly pathD: string;
  readonly isActive: boolean;
  readonly leftTop: number;
  readonly leftBottom: number;
  readonly rightTop: number;
  readonly rightBottom: number;
}

const MIN_BAND_HEIGHT_PX = 2;

export function classifyChangeKind(change: IdeDiffHunkChange): ConnectorBandKind {
  if (change.originalEndLineNumber === 0) return "added";
  if (change.modifiedEndLineNumber === 0) return "deleted";
  return "modified";
}

function resolveSpan(
  startLine: number,
  endLine: number,
  getTop: (lineNumber: number) => number,
  lineHeight: number,
): { readonly top: number; readonly bottom: number } {
  if (endLine === 0) {
    // Pure insertion or pure deletion anchor sits at the boundary below `startLine`.
    const anchorY = startLine <= 0 ? 0 : getTop(startLine) + lineHeight;
    return {
      top: anchorY - MIN_BAND_HEIGHT_PX / 2,
      bottom: anchorY + MIN_BAND_HEIGHT_PX / 2,
    };
  }
  const top = getTop(startLine);
  const lastLineTop = getTop(endLine);
  const bottom = Math.max(top + MIN_BAND_HEIGHT_PX, lastLineTop + lineHeight);
  return { top, bottom };
}

function roundCoord(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeConnectorBands(input: {
  readonly changes: ReadonlyArray<IdeDiffHunkChange>;
  readonly width: number;
  readonly height: number;
  readonly getOriginalTop: (lineNumber: number) => number;
  readonly getModifiedTop: (lineNumber: number) => number;
  readonly lineHeight: number;
  readonly activeIndex: number;
}): ReadonlyArray<ConnectorBandGeometry> {
  const { changes, width, height, getOriginalTop, getModifiedTop, lineHeight, activeIndex } = input;
  if (width <= 0 || height <= 0 || changes.length === 0) return [];

  const cpX = roundCoord(width * 0.5);
  const rightX = roundCoord(width);
  const bands: ConnectorBandGeometry[] = [];

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    const kind = classifyChangeKind(change);
    const left = resolveSpan(
      change.originalStartLineNumber,
      change.originalEndLineNumber,
      getOriginalTop,
      lineHeight,
    );
    const right = resolveSpan(
      change.modifiedStartLineNumber,
      change.modifiedEndLineNumber,
      getModifiedTop,
      lineHeight,
    );

    const minY = Math.min(left.top, right.top);
    const maxY = Math.max(left.bottom, right.bottom);
    // Skip bands completely outside the vertical viewport (with small buffer for curves).
    if (maxY < -16 || minY > height + 16) continue;

    const lTop = roundCoord(left.top);
    const lBot = roundCoord(left.bottom);
    const rTop = roundCoord(right.top);
    const rBot = roundCoord(right.bottom);

    const pathD = [
      `M 0 ${lTop}`,
      `C ${cpX} ${lTop}, ${cpX} ${rTop}, ${rightX} ${rTop}`,
      `L ${rightX} ${rBot}`,
      `C ${cpX} ${rBot}, ${cpX} ${lBot}, 0 ${lBot}`,
      "Z",
    ].join(" ");

    bands.push({
      index,
      kind,
      pathD,
      isActive: index === activeIndex,
      leftTop: lTop,
      leftBottom: lBot,
      rightTop: rTop,
      rightBottom: rBot,
    });
  }

  return bands;
}
