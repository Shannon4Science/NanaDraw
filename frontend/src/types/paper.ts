export interface StyleSpec {
  visual_style?: string | null;
  color_preset?: string | null;
  font_scheme?: string | null;
  topology?: string | null;
  layout_direction?: string | null;
  description?: string | null;
}

export type AssistantMode = "auto" | "fast" | "full_gen" | "image_only" | "gpt_image" | "free" | "text_edit";

export interface GenerateOptions {
  diagram_type?: "pipeline" | "architecture" | "framework" | "table" | "concept_map" | "comparison" | "freeform";
  color_scheme: "pastel" | "vibrant" | "monochrome";
  image_model?: string;
  component_image_model?: string;
  image_only?: boolean;
  gpt_image?: boolean;
  free?: boolean;
  text_edit?: boolean;
  model_preset?: string;
  canvas_type?: "drawio" | "ppt";
}

export interface GenerateRequest {
  text: string;
  mode: "fast" | "full_gen";
  style_ref_id?: string;
  style_spec?: StyleSpec;
  options: GenerateOptions;
  request_id?: string;
  resume_from?: string;
  sketch_image_b64?: string;
}

export interface StyleReference {
  id: string;
  name: string;
  title: string;
  authors: string[];
  year: string;
  conference: string;
  category: string;
  thumbnail_url: string;
  image_url: string;
  tags: string[];
  paper_url: string;
  code_url: string;
  project_url: string;
  abstract: string;
  bibtex: string;
  style_description: string;
}

export interface GallerySearchResult extends StyleReference {
  score: number;
}

export interface SSEStatusEvent {
  step: string;
  progress: number;
  message: string;
}

export interface SSEResultEvent {
  xml: string;
}

export interface PlanStep {
  id: string;
  label: string;
  description: string;
  shape: string;
  color_hint: string;
  inputs: string[];
  outputs: string[];
}

export interface ContentElement {
  id: string;
  label: string;
  description: string;
  category: string;
}

export interface DiagramPlan {
  title: string;
  diagram_type: string;
  layout: string;
  content_type: "pipeline" | "freeform";
  steps: PlanStep[];
  elements: ContentElement[];
  content_description: string;
  style_notes: string;
}
