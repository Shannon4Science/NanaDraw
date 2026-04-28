import { describe, expect, it } from "vitest";
import { classifyUploadFile } from "./chatUpload";

describe("classifyUploadFile", () => {
  it("routes images to the sketch reference flow", () => {
    expect(classifyUploadFile({ name: "sketch.png", type: "image/png" })).toBe("image");
  });

  it("routes PDFs to the MinerU parsing flow", () => {
    expect(classifyUploadFile({ name: "paper.pdf", type: "" })).toBe("pdf");
    expect(classifyUploadFile({ name: "paper", type: "application/pdf" })).toBe("pdf");
  });

  it("routes Markdown and text files to the text attachment flow", () => {
    expect(classifyUploadFile({ name: "notes.md", type: "" })).toBe("markdown");
    expect(classifyUploadFile({ name: "notes.markdown", type: "" })).toBe("markdown");
    expect(classifyUploadFile({ name: "prompt.txt", type: "" })).toBe("text");
    expect(classifyUploadFile({ name: "prompt", type: "text/plain" })).toBe("text");
  });

  it("rejects unsupported upload types", () => {
    expect(classifyUploadFile({ name: "archive.zip", type: "application/zip" })).toBe("unsupported");
  });
});
