export type CanvasType = "drawio";

/**
 * Unified editor handle interface for the draw.io canvas.
 */
export interface EditorHandle {
  loadResult: (data: { xml?: string; image?: string }) => void;
  addPage: (data: { xml?: string; image?: string }, name?: string) => void;
  insertElement: (data: { svgText?: string; imageB64?: string; label?: string }) => void;
  replaceComponent: (componentId: string, imageB64: string) => void;
  clearCanvas?: () => void;
  exportSvg: () => void;
  exportPng: () => void;
  exportPptx: () => void;
  exportPdf?: () => void;
  getData: () => Promise<string>;
}
