export const ACCEPTED_UPLOAD_TYPES = "image/*,.pdf,application/pdf,.md,.txt,.markdown,text/plain,text/markdown";

export type UploadFileKind = "image" | "pdf" | "markdown" | "text" | "unsupported";

export function classifyUploadFile(file: Pick<File, "name" | "type">): UploadFileKind {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (ext === "pdf" || file.type === "application/pdf") return "pdf";
  if (ext === "md" || ext === "markdown" || file.type === "text/markdown") return "markdown";
  if (ext === "txt" || file.type === "text/plain") return "text";
  return "unsupported";
}
