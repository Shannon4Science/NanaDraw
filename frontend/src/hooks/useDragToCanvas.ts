import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createElement } from "react";
import type { DiagramEditorHandle } from "../components/DiagramEditor";

const DRAG_THRESHOLD = 5;
let _mergeCounter = 0;
function nextMergeId(): string {
  return `asset_${Date.now()}_${++_mergeCounter}`;
}

let _insertOffset = 0;

export interface DragPayload {
  type: "png" | "svg";
  data: string;
  width?: number;
  height?: number;
  previewUrl?: string;
}

interface GhostState {
  x: number;
  y: number;
  previewUrl: string;
  overEditor: boolean;
}

interface DragInfo {
  startX: number;
  startY: number;
  moved: boolean;
  payload: DragPayload;
}

function isOverEditor(x: number, y: number): boolean {
  const iframe = document.querySelector(".diagrams-iframe");
  if (!iframe) return false;
  const rect = iframe.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function buildPngMergeXml(b64: string, w: number, h: number): string {
  const id = nextMergeId();
  const col = _insertOffset % 6;
  const row = Math.floor(_insertOffset / 6) % 4;
  const x = 100 + col * 120;
  const y = 100 + row * 120;
  _insertOffset++;

  const dataUri = `data:image/png;base64,${b64}`;
  const htmlLabel = `&lt;img src=&quot;${dataUri}&quot; style=&quot;max-width:100%;max-height:100%&quot;&gt;`;
  return [
    "<mxGraphModel>",
    "  <root>",
    '    <mxCell id="0"/>',
    '    <mxCell id="1" parent="0"/>',
    `    <mxCell id="${id}" value="${htmlLabel}" style="text;html=1;overflow=fill;fillColor=none;strokeColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;" vertex="1" parent="1">`,
    `      <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`,
    "    </mxCell>",
    "  </root>",
    "</mxGraphModel>",
  ].join("\n");
}

function buildSvgMergeXml(svgText: string, w: number, h: number): string {
  const id = nextMergeId();
  const col = _insertOffset % 6;
  const row = Math.floor(_insertOffset / 6) % 4;
  const x = 100 + col * 120;
  const y = 100 + row * 120;
  _insertOffset++;

  const encodedSvg = encodeURIComponent(svgText);
  const style = [
    "shape=image",
    "verticalLabelPosition=bottom",
    "labelBackgroundColor=default",
    "verticalAlign=top",
    "aspect=fixed",
    "imageAspect=0",
    `image=data:image/svg+xml,${encodedSvg}`,
  ].join(";");

  return [
    "<mxGraphModel>",
    "  <root>",
    '    <mxCell id="0"/>',
    '    <mxCell id="1" parent="0"/>',
    `    <mxCell id="${id}" value="" style="${style}" vertex="1" parent="1">`,
    `      <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`,
    "    </mxCell>",
    "  </root>",
    "</mxGraphModel>",
  ].join("\n");
}

export function useDragToCanvas(
  editorRef: RefObject<DiagramEditorHandle | null>,
) {
  const dragInfoRef = useRef<DragInfo | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [ghostPos, setGhostPos] = useState<GhostState | null>(null);

  const showOverlay = useCallback(() => {
    if (overlayRef.current) return;
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;inset:0;z-index:99998;cursor:grabbing;";
    document.body.appendChild(el);
    overlayRef.current = el;
  }, []);

  const hideOverlay = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.remove();
      overlayRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      if (!drag.moved) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) return;
        drag.moved = true;
        showOverlay();
        document.body.style.userSelect = "none";
      }

      setGhostPos({
        x: e.clientX,
        y: e.clientY,
        previewUrl: drag.payload.previewUrl || "",
        overEditor: isOverEditor(e.clientX, e.clientY),
      });
    };

    const handleMouseUp = (e: MouseEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      hideOverlay();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      const shouldInsert = drag.moved && isOverEditor(e.clientX, e.clientY);

      if (shouldInsert) {
        const { payload } = drag;
        const w = payload.width || 200;
        const h = payload.height || 200;

        if (editorRef.current) {
          const xml =
            payload.type === "svg"
              ? buildSvgMergeXml(payload.data, w, h)
              : buildPngMergeXml(payload.data, w, h);
          editorRef.current.mergeXml(xml);
        }
      }

      dragInfoRef.current = null;
      setGhostPos(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragInfoRef.current) {
        hideOverlay();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dragInfoRef.current = null;
        setGhostPos(null);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
      hideOverlay();
    };
  }, [editorRef, showOverlay, hideOverlay]);

  const startDrag = useCallback(
    (e: React.MouseEvent, payload: DragPayload) => {
      e.preventDefault();
      dragInfoRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        payload,
      };
    },
    [],
  );

  const ghostElement = ghostPos
    ? createPortal(
        createElement(
          "div",
          {
            style: {
              position: "fixed",
              left: ghostPos.x - 30,
              top: ghostPos.y - 30,
              width: 60,
              height: 60,
              pointerEvents: "none" as const,
              zIndex: 99999,
              opacity: ghostPos.overEditor ? 0.9 : 0.5,
              transition: "opacity 0.15s",
              borderRadius: 8,
              border: ghostPos.overEditor
                ? "2px solid #818cf8"
                : "2px dashed #94a3b8",
              background: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            },
          },
          ghostPos.previewUrl
            ? createElement("img", {
                src: ghostPos.previewUrl,
                alt: "",
                style: {
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain" as const,
                },
              })
            : null,
        ),
        document.body,
      )
    : null;

  return { startDrag, ghostElement };
}
