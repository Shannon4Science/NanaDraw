import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePdfDocument } from "./api";

describe("parsePdfDocument", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the PDF to the document parsing endpoint", async () => {
    const payload = {
      file_name: "paper.pdf",
      markdown: "# Parsed",
      batch_id: "batch-1",
      data_id: "data-1",
      source: "mineru",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await parsePdfDocument(new File(["%PDF"], "paper.pdf", { type: "application/pdf" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/documents/parse-pdf", {
      method: "POST",
      body: expect.any(FormData),
    });
    expect(result).toEqual(payload);
  });

  it("uses backend detail for failed parsing requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "请先在设置中配置 MinerU Token" }), { status: 400 })),
    );

    await expect(parsePdfDocument(new File(["%PDF"], "paper.pdf"))).rejects.toThrow("MinerU Token");
  });
});
