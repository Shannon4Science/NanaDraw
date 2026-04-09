import { describe, it, expect } from "vitest";
import { parseStyleStr, toHex6, stripHtml, extractImageUrl } from "./pptxExport";

// ---------------------------------------------------------------------------
// parseStyleStr
// ---------------------------------------------------------------------------
describe("parseStyleStr", () => {
  it("returns empty object for empty string", () => {
    expect(parseStyleStr("")).toEqual({});
  });

  it("parses key=value pairs", () => {
    const result = parseStyleStr("rounded=1;fillColor=#FFF;strokeColor=#000");
    expect(result).toEqual({
      rounded: "1",
      fillColor: "#FFF",
      strokeColor: "#000",
    });
  });

  it("parses flag-only entries (no =)", () => {
    const result = parseStyleStr("rounded;whiteSpace=wrap;html=1");
    expect(result).toEqual({ rounded: "1", whiteSpace: "wrap", html: "1" });
  });

  it("handles leading/trailing semicolons", () => {
    const result = parseStyleStr(";fillColor=#FFF;");
    expect(result.fillColor).toBe("#FFF");
  });

  it("handles data URI in image field (preserves internal semicolons)", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANS";
    const raw = `shape=image;image=${dataUri};aspect=fixed`;
    const result = parseStyleStr(raw);
    expect(result.image).toBe(dataUri);
    expect(result.shape).toBe("image");
    expect(result.aspect).toBe("fixed");
  });

  it("handles complex style with mixed flags and values", () => {
    const raw =
      "edgeStyle=orthogonalEdgeStyle;curved=1;orthogonalLoop=1;jettySize=auto";
    const result = parseStyleStr(raw);
    expect(result.edgeStyle).toBe("orthogonalEdgeStyle");
    expect(result.curved).toBe("1");
    expect(result.jettySize).toBe("auto");
  });

  it("handles flexArrow shape", () => {
    const raw =
      "shape=flexArrow;fillColor=#4A90D9;strokeColor=#3A7AC0;endWidth=20";
    const result = parseStyleStr(raw);
    expect(result.shape).toBe("flexArrow");
    expect(result.fillColor).toBe("#4A90D9");
  });
});

// ---------------------------------------------------------------------------
// toHex6
// ---------------------------------------------------------------------------
describe("toHex6", () => {
  it("returns empty for empty string", () => {
    expect(toHex6("")).toBe("");
  });

  it('returns empty for "none"', () => {
    expect(toHex6("none")).toBe("");
  });

  it('returns empty for "default"', () => {
    expect(toHex6("default")).toBe("");
  });

  it("strips # prefix and uppercases", () => {
    expect(toHex6("#ff0000")).toBe("FF0000");
  });

  it("expands 3-char hex to 6-char", () => {
    expect(toHex6("#f0a")).toBe("ff00aa");
  });

  it("handles hex without #", () => {
    expect(toHex6("4A90D9")).toBe("4A90D9");
  });
});

// ---------------------------------------------------------------------------
// stripHtml (uses jsdom)
// ---------------------------------------------------------------------------
describe("stripHtml", () => {
  it("returns empty for empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  it("strips basic HTML tags", () => {
    expect(stripHtml("<b>Bold</b>")).toBe("Bold");
  });

  it("strips nested tags", () => {
    expect(stripHtml("<p><span style='color:red'>Hello</span> World</p>")).toBe(
      "Hello World",
    );
  });

  it("handles entities", () => {
    expect(stripHtml("&amp; &lt;tag&gt;")).toBe("& <tag>");
  });

  it("returns plain text unchanged", () => {
    expect(stripHtml("plain text")).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// extractImageUrl (uses jsdom)
// ---------------------------------------------------------------------------
describe("extractImageUrl", () => {
  it("returns undefined when no image", () => {
    expect(extractImageUrl({}, "")).toBeUndefined();
  });

  it("extracts from style.image data URI", () => {
    const uri = "data:image/png;base64,iVBOR...";
    const result = extractImageUrl({ image: uri }, "");
    expect(result).toBe(uri);
  });

  it("extracts from HTML img tag in value", () => {
    const uri = "data:image/png;base64,ABCDEF";
    const html = `<img src="${uri}" />`;
    const result = extractImageUrl({}, html);
    expect(result).toBe(uri);
  });

  it("decodes percent-encoded data URI", () => {
    const encoded = "data:image/png%3Bbase64%2CiVBOR";
    const result = extractImageUrl({ image: encoded }, "");
    expect(result).toBe("data:image/png;base64,iVBOR");
  });

  it("returns undefined for non-data URI image", () => {
    const result = extractImageUrl({ image: "https://example.com/img.png" }, "");
    expect(result).toBeUndefined();
  });
});
