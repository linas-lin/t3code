import { useEffect, useState } from "react";

import {
  computeConnectorBands,
  type ConnectorBandGeometry,
  type ConnectorBandKind,
} from "./connectorGeometry.logic";
import { monaco } from "./monacoWorkers";
import type { IdeDiffHunkChange } from "./types";

const CONNECTOR_STRIP_WIDTH_PX = 24;

export interface DiffConnectorOverlayProps {
  readonly diffEditor: monaco.editor.IStandaloneDiffEditor | null;
  readonly changes: ReadonlyArray<IdeDiffHunkChange>;
  readonly activeChangeIndex: number;
  readonly resolvedTheme: "light" | "dark";
  readonly onSelectChange: (index: number) => void;
}

interface BandColors {
  readonly fill: string;
  readonly activeFill: string;
  readonly stroke: string;
  readonly activeStroke: string;
}

function getBandColors(kind: ConnectorBandKind, resolvedTheme: "light" | "dark"): BandColors {
  const isDark = resolvedTheme === "dark";
  switch (kind) {
    case "added":
      return isDark
        ? {
            fill: "rgba(46, 160, 67, 0.24)",
            activeFill: "rgba(63, 185, 80, 0.44)",
            stroke: "rgba(63, 185, 80, 0.55)",
            activeStroke: "rgba(86, 211, 100, 0.9)",
          }
        : {
            fill: "rgba(34, 197, 94, 0.22)",
            activeFill: "rgba(22, 163, 74, 0.38)",
            stroke: "rgba(22, 163, 74, 0.45)",
            activeStroke: "rgba(21, 128, 61, 0.85)",
          };
    case "deleted":
      return isDark
        ? {
            fill: "rgba(248, 81, 73, 0.24)",
            activeFill: "rgba(248, 81, 73, 0.46)",
            stroke: "rgba(248, 81, 73, 0.55)",
            activeStroke: "rgba(255, 123, 114, 0.9)",
          }
        : {
            fill: "rgba(239, 68, 68, 0.2)",
            activeFill: "rgba(220, 38, 38, 0.36)",
            stroke: "rgba(220, 38, 38, 0.45)",
            activeStroke: "rgba(185, 28, 28, 0.85)",
          };
    case "modified":
      return isDark
        ? {
            fill: "rgba(79, 140, 255, 0.24)",
            activeFill: "rgba(79, 140, 255, 0.46)",
            stroke: "rgba(96, 165, 250, 0.58)",
            activeStroke: "rgba(147, 197, 253, 0.92)",
          }
        : {
            fill: "rgba(59, 130, 246, 0.2)",
            activeFill: "rgba(37, 99, 235, 0.36)",
            stroke: "rgba(37, 99, 235, 0.48)",
            activeStroke: "rgba(29, 78, 216, 0.85)",
          };
  }
}

export function DiffConnectorOverlay({
  diffEditor,
  changes,
  activeChangeIndex,
  resolvedTheme,
  onSelectChange,
}: DiffConnectorOverlayProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [geometry, setGeometry] = useState<{
    readonly leftPx: number;
    readonly heightPx: number;
    readonly bands: ReadonlyArray<ConnectorBandGeometry>;
  }>({ leftPx: 0, heightPx: 0, bands: [] });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to imperative Monaco scroll/layout events to position IDEA connector bands
  useEffect(() => {
    if (!diffEditor) return;

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    let frameId = 0;

    const recompute = () => {
      const origLayout = originalEditor.getLayoutInfo();
      const modLayout = modifiedEditor.getLayoutInfo();
      const heightPx = Math.max(origLayout.height, modLayout.height);
      const origScrollTop = originalEditor.getScrollTop();
      const modScrollTop = modifiedEditor.getScrollTop();
      const lineHeight = originalEditor.getOption(monaco.editor.EditorOption.lineHeight) || 19;

      // Place the connector strip directly across the seam between original & modified editors.
      const leftPx = Math.max(0, origLayout.width - CONNECTOR_STRIP_WIDTH_PX / 2);

      const bands = computeConnectorBands({
        changes,
        width: CONNECTOR_STRIP_WIDTH_PX,
        height: heightPx,
        lineHeight,
        activeIndex: activeChangeIndex,
        getOriginalTop: (line) => originalEditor.getTopForLineNumber(line) - origScrollTop,
        getModifiedTop: (line) => modifiedEditor.getTopForLineNumber(line) - modScrollTop,
      });

      setGeometry({ leftPx, heightPx, bands });
    };

    const scheduleRecompute = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        recompute();
      });
    };

    scheduleRecompute();
    const disposables = [
      originalEditor.onDidScrollChange(scheduleRecompute),
      modifiedEditor.onDidScrollChange(scheduleRecompute),
      originalEditor.onDidLayoutChange(scheduleRecompute),
      modifiedEditor.onDidLayoutChange(scheduleRecompute),
      diffEditor.onDidUpdateDiff(scheduleRecompute),
    ];

    return () => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      for (const disposable of disposables) disposable.dispose();
    };
  }, [activeChangeIndex, changes, diffEditor]);

  if (!diffEditor || geometry.heightPx <= 0 || geometry.bands.length === 0) {
    return null;
  }

  return (
    <svg
      aria-hidden="true"
      data-ide-diff-connectors
      width={CONNECTOR_STRIP_WIDTH_PX}
      height={geometry.heightPx}
      style={{ left: `${geometry.leftPx}px` }}
      className="pointer-events-none absolute top-0 z-10 overflow-visible"
    >
      {geometry.bands.map((band) => {
        const colors = getBandColors(band.kind, resolvedTheme);
        const emphasized = band.isActive || hoveredIndex === band.index;
        return (
          <path
            key={band.index}
            d={band.pathD}
            fill={emphasized ? colors.activeFill : colors.fill}
            stroke={emphasized ? colors.activeStroke : colors.stroke}
            strokeWidth={emphasized ? 1.25 : 0.75}
            className="pointer-events-auto cursor-pointer transition-colors duration-75"
            onMouseEnter={() => setHoveredIndex(band.index)}
            onMouseLeave={() =>
              setHoveredIndex((current) => (current === band.index ? null : current))
            }
            onClick={() => onSelectChange(band.index)}
          />
        );
      })}
    </svg>
  );
}
