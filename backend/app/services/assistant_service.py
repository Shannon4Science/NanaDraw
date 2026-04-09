"""AI Assistant service — LLM tool-calling loop and inline pipeline execution."""

import json
import logging
import re
import time
import uuid
import xml.etree.ElementTree as ET
from collections.abc import AsyncGenerator

from app.prompts.asset_gen import ASSET_GEN_SYSTEM, ASSET_GEN_USER, STYLE_DESCRIPTIONS
from app.prompts.assistant import ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOOLS
from app.schemas.paper import (
    GenerateMode,
    GenerateOptions,
    GenerateRequest,
    StyleSpec,
)
from app.services.gallery_service import get_gallery_service
from app.services.llm_service import LLMService
from app.services.settings_service import get_setting

logger = logging.getLogger(__name__)


def _sse(event: str, data: dict | str) -> str:
    payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
    return f"event: {event}\ndata: {payload}\n\n"


def _synthetic_pre_message(fn_name: str, fn_args_raw: str | dict, locale: str = "zh") -> str:
    en = locale == "en"
    args = json.loads(fn_args_raw) if isinstance(fn_args_raw, str) else fn_args_raw
    if fn_name == "generate_diagram":
        mode = args.get("mode", "image_only")
        if en:
            mode_label = {
                "draft": "Draft Mode",
                "full_gen": "Assembly Mode",
                "image_only": "Image Mode",
            }.get(mode, mode)
        else:
            mode_label = {
                "draft": "草稿模式",
                "full_gen": "组装模式",
                "image_only": "生成模式",
            }.get(mode, mode)
        if mode == "full_gen":
            if en:
                return (
                    f"Got it~ 🍌 Let me draw that for you! Using {mode_label}, starting the pipeline now~\n\n"
                    "⏳ Depending on network conditions and content complexity, this may take about "
                    "**4-8 minutes**. Please be patient — I'll do my best to create something beautiful! ✨"
                )
            return (
                f"收到啦~ 🍌 香蕉宝宝这就帮你画！使用{mode_label}，马上开始流程~\n\n"
                "⏳ 根据网络情况和内容复杂程度，大概需要 **4-8 分钟**的等待时间，"
                "请耐心等待一下哦~ 香蕉宝宝会努力画出好看的图的！✨"
            )
        if en:
            return f"Got it~ 🍌 Let me draw that for you! Using {mode_label}, starting now~ ✨"
        return f"收到啦~ 🍌 香蕉宝宝这就帮你画！使用{mode_label}，马上开始流程，请稍等一下哦~ ✨"
    if fn_name == "generate_assets":
        if en:
            return "Sure~ 🎨 Let me generate assets for you right away~ ✨"
        return "好哒~ 🎨 香蕉宝宝马上帮你生成素材，请稍等一下哦~ ✨"
    if fn_name == "modify_canvas":
        if en:
            return "Sure~ ✏️ Let me modify the canvas for you~ 🍌"
        return "好哒~ ✏️ 香蕉宝宝马上帮你修改画布~ 🍌"
    if fn_name == "search_gallery":
        if en:
            return "Let me search the gallery for you~ 🔍"
        return "让我帮你在素材库里搜搜看~ 🔍"
    if en:
        return "On it~ 🍌"
    return "好的，马上处理~ 🍌"


def _parse_result_image_from_sse(chunk: str) -> str | None:
    if "event: result" not in chunk:
        return None
    for block in chunk.strip().split("\n\n"):
        event_name = None
        data_line = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                event_name = line[7:].strip()
            elif line.startswith("data: ") and event_name == "result":
                data_line = line[6:]
        if not data_line:
            continue
        try:
            payload = json.loads(data_line)
            img = payload.get("image")
            if isinstance(img, str) and img:
                if img.startswith("data:") and "," in img:
                    return img.split(",", 1)[1]
                return img
        except json.JSONDecodeError:
            continue
    return None


class AssistantService:
    def __init__(
        self,
        username: str = "anonymous",
        canvas_type: str = "drawio",
    ) -> None:
        self.llm = LLMService()
        self.llm.log_tag = f"[assistant user={username}] "
        self.gallery = get_gallery_service()
        self.username = username
        self.canvas_type = canvas_type
        self.image_model_override: str | None = None
        self.component_image_model_override: str | None = None
        self._last_result_image_b64: str | None = None
        self._last_pipeline_failed: bool = False
        self._last_pipeline_error: str = ""
        self._locale: str = "zh"

    async def chat_stream(
        self,
        message: str,
        history: list[dict],
        *,
        selected_mode: str | None = None,
        style_ref_id: str | None = None,
        session_id: str | None = None,
        sketch_image_b64: str | None = None,
        canvas_skeleton: str | None = None,
        canvas_skeleton_full: str | None = None,
        canvas_images: dict[str, str] | None = None,
        canvas_type: str | None = None,
        locale: str = "zh",
        regen_context: dict | None = None,
    ) -> AsyncGenerator[str, None]:
        _ = session_id
        self._locale = locale

        if regen_context:
            async for evt in self._handle_regen_component(message, regen_context):
                yield evt
            return

        nana_soul = str(get_setting("nana_soul") or "").strip() or None

        system_prompt = ASSISTANT_SYSTEM_PROMPT
        if locale == "en":
            system_prompt += (
                "\n\n[LANGUAGE OVERRIDE] The user's interface is set to English. "
                "You MUST respond in English. Keep your warm and encouraging personality "
                "but speak English instead of Chinese. Use cute expressions like "
                "'Got it~', 'No problem~', 'Let me draw that for you!', 'Here we go~' "
                "instead of Chinese ones. Still use occasional emojis like 🍌 ✨ 🎨 sparingly."
            )
        if selected_mode and selected_mode != "auto":
            mode_map = {
                "fast": "draft",
                "full_gen": "full_gen",
                "image_only": "image_only",
                "slides": "full_gen",
            }
            forced = mode_map.get(selected_mode, selected_mode)
            if locale == "en":
                label_map = {
                    "draft": "Draft Mode",
                    "full_gen": "Assembly Mode",
                    "image_only": "Image Mode",
                }
            else:
                label_map = {
                    "draft": "草稿模式",
                    "full_gen": "组装模式",
                    "image_only": "生成模式",
                }
            forced_label = label_map.get(forced, forced)
            system_prompt += (
                f"\n\n[MODE CONSTRAINT] The user has locked the generation mode to "
                f"{forced_label}. When calling generate_diagram, always pass "
                f"mode='{forced}' in the tool call. "
                f"Do NOT override this choice. When speaking to the user, refer to "
                f"this mode as '{forced_label}' — NEVER use the internal identifier.\n"
                f"IMPORTANT: This constraint ONLY applies to generate_diagram's mode parameter. "
                f"All other tools (modify_canvas, generate_assets, search_gallery) "
                f"are ALWAYS available regardless of the locked mode."
            )
        self._selected_mode = selected_mode
        self._style_ref_id = style_ref_id
        self._sketch_image_b64 = sketch_image_b64

        if sketch_image_b64:
            system_prompt += (
                "\n\n[SKETCH IMAGE] The user has uploaded a sketch/draft image. "
                "This image is automatically available as `sketch_image` parameter — "
                "you do NOT need the user to provide detailed text descriptions. "
                "A short instruction like '根据草稿生成流程图' is sufficient. "
                "When calling generate_diagram, pass a brief description as `text` "
                "and the sketch will be automatically included. "
                "Mention that you'll use their sketch as a layout reference."
            )

        if style_ref_id:
            ref_name = style_ref_id
            try:
                ref_obj = self.gallery.get_by_id(style_ref_id)
                if ref_obj:
                    ref_name = ref_obj.name
            except Exception:
                pass
            system_prompt += (
                f"\n\n[STYLE REFERENCE] The user has selected a style reference image: "
                f"'{ref_name}' (id={style_ref_id}). This image will be automatically "
                f"passed to the generation pipeline as visual style guidance. "
                f"When replying, briefly mention that you'll use their selected "
                f"reference image for style guidance. "
                f"STYLE CONFLICT RULE: If the user also mentions style keywords in "
                f"their message that differ from the reference image's apparent style "
                f"(e.g. reference is flat/minimalist but user says '赛博朋克'), you MUST "
                f"proactively ask which to follow: '你选了参考图 {ref_name} 的风格，"
                f"但你也提到了 XX 风格，我应该以哪个为准呀？' Do NOT silently ignore "
                f"the conflict."
            )

        if nana_soul:
            system_prompt += (
                f'\n\n[NANA SOUL] The user has set persistent drawing style constraints:\n'
                f'"{nana_soul}"\n'
                f'These constraints are ALREADY applied to the generation pipeline. '
                f'When evaluating style sufficiency, consider these as provided style '
                f'information — do NOT ask about style aspects already covered by NanaSoul. '
                f'When replying, you may briefly acknowledge the user\'s style preference.'
            )

        self._canvas_skeleton = canvas_skeleton
        self._canvas_skeleton_full = canvas_skeleton_full
        self._canvas_images = canvas_images or {}
        self._canvas_type = canvas_type or "drawio"

        self._img_placeholder_map: dict[str, str] = {}
        if canvas_skeleton:
            unique_refs = list(dict.fromkeys(
                re.findall(r"nanadraw://img/[a-f0-9]{64}", canvas_skeleton)
            ))
            for i, ref in enumerate(unique_refs):
                self._img_placeholder_map[f"__IMG_{i + 1}__"] = ref

        if canvas_skeleton and canvas_skeleton.strip():
            skel = canvas_skeleton.strip()
            for ph, full_ref in self._img_placeholder_map.items():
                skel = skel.replace(full_ref, ph)
            max_canvas_chars = 80_000
            if len(skel) > max_canvas_chars:
                skel = skel[:max_canvas_chars] + "\n... (canvas too large, truncated)"
            logger.info(
                "[assistant user=%s] Canvas skeleton injected (len=%d stripped, full=%d chars, img_placeholders=%d)",
                self.username,
                len(skel),
                len(canvas_skeleton_full) if canvas_skeleton_full else 0,
                len(self._img_placeholder_map),
            )
            img_note = ""
            if self._img_placeholder_map:
                img_note = (
                    "\nImage references use short placeholders (__IMG_1__, __IMG_2__, etc.) "
                    "instead of full nanadraw://img/ URIs. You MUST preserve these "
                    "placeholders exactly as they appear when modifying the XML.\n"
                )
            system_prompt += (
                "\n\n[CANVAS_XML] The CURRENT PAGE content of the draw.io canvas "
                "(images replaced with short __IMG_N__ placeholders, "
                "nanadraw_visual_repr and nanadraw_style_notes stripped for brevity):\n"
                f"```xml\n{skel}\n```\n"
                f"{img_note}"
                "This is a single page (mxGraphModel), not the full mxfile. "
                "When modifying, output a complete mxGraphModel (not mxfile). "
                "You can call modify_canvas to apply changes to the current page.\n"
            )

        messages: list[dict] = [
            {"role": "system", "content": system_prompt},
        ]
        for h in history:
            messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
        messages.append({"role": "user", "content": message})

        max_rounds = 5
        for round_idx in range(max_rounds):
            t_llm = time.monotonic()
            try:
                assistant_msg = await self.llm.chat_with_tools(
                    messages,
                    ASSISTANT_TOOLS,
                    temperature=0.3,
                )
            except Exception as e:
                logger.exception("Assistant LLM call failed")
                yield _sse("assistant_message", {"content": f"抱歉，调用模型时出错：{e}", "done": True})
                return
            llm_ms = int((time.monotonic() - t_llm) * 1000)

            tool_calls = assistant_msg.get("tool_calls")
            text_content = assistant_msg.get("content") or ""
            logger.info(
                "[assistant user=%s] LLM round %d completed in %dms (tools=%s, content_len=%d)",
                self.username,
                round_idx + 1,
                llm_ms,
                [tc["function"]["name"] for tc in tool_calls] if tool_calls else None,
                len(text_content),
            )

            if text_content and not tool_calls:
                yield _sse("assistant_message", {"content": text_content, "done": True})
                return

            if text_content:
                yield _sse("assistant_message", {"content": text_content, "done": False})

            if not tool_calls:
                fallback = "Anything else I can help with?" if self._locale == "en" else "好的，还有什么需要帮助的吗？"
                final = text_content or fallback
                yield _sse("assistant_message", {"content": final, "done": True})
                return

            if not text_content and tool_calls:
                first_fn = tool_calls[0]["function"]["name"]
                synthetic = _synthetic_pre_message(
                    first_fn,
                    tool_calls[0]["function"].get("arguments", "{}"),
                    self._locale,
                )
                yield _sse("assistant_message", {"content": synthetic, "done": False})

            messages.append(assistant_msg)

            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                fn_args_raw = tc["function"].get("arguments", "{}")
                fn_args = json.loads(fn_args_raw) if isinstance(fn_args_raw, str) else fn_args_raw
                tc_id = tc.get("id", fn_name)

                yield _sse("tool_call", {"name": fn_name, "arguments": fn_args})

                if fn_name == "search_gallery":
                    result_str = await self._tool_search_gallery(fn_args)
                    yield _sse("tool_result", {"name": fn_name, "summary": result_str})
                    messages.append({"role": "tool", "tool_call_id": tc_id, "content": result_str})

                elif fn_name == "generate_diagram":
                    async for evt in self._tool_generate_diagram(fn_args, nana_soul=nana_soul):
                        yield evt
                    en = self._locale == "en"
                    if self._last_pipeline_failed:
                        tool_content = self._last_pipeline_error
                    else:
                        tool_content = (
                            "Diagram generated successfully and loaded onto the canvas."
                            if en
                            else "图表已成功生成并加载到画布。"
                        )
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": tool_content,
                    })

                elif fn_name == "generate_assets":
                    summary = ""
                    async for evt in self._tool_generate_assets(fn_args):
                        yield evt
                        if "asset_results" in evt:
                            try:
                                payload = evt.split("data: ", 1)[1].strip()
                                data = json.loads(payload)
                                n_images = len(data.get("images", []))
                                if self._locale == "en":
                                    summary = (
                                        f"Generated {n_images} assets. "
                                        "Tell the user: each asset has a 'Save' button below to add it to 'My Assets'; "
                                        "saved assets can be managed and reused in the 'My Assets' tab of the Asset Workshop; "
                                        "they can also drag asset images directly onto the canvas."
                                    )
                                else:
                                    summary = (
                                        f"已生成 {n_images} 个素材。"
                                        "告诉用户：每个素材下方有「保存」按钮，点击可添加到「我的素材」；"
                                        "保存后可在左侧「素材工坊」浮窗的「我的素材」标签页中管理和复用；"
                                        "也可以直接拖拽素材图片到画布中使用。"
                                    )
                            except Exception:
                                summary = "Assets generated." if self._locale == "en" else "素材已生成。"
                    asset_summary = summary or ("Done." if self._locale == "en" else "完成。")
                    yield _sse("tool_result", {"name": fn_name, "summary": asset_summary})
                    messages.append({"role": "tool", "tool_call_id": tc_id, "content": asset_summary})

                elif fn_name == "modify_canvas":
                    result_str = await self._tool_modify_canvas(fn_args)
                    canvas_updated = "Canvas updated." if self._locale == "en" else "画布已更新。"
                    if result_str.startswith("ERROR:"):
                        yield _sse("tool_result", {"name": fn_name, "summary": result_str})
                    else:
                        yield result_str
                        yield _sse("tool_result", {"name": fn_name, "summary": canvas_updated})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result_str if result_str.startswith("ERROR:") else canvas_updated,
                    })

                else:
                    err = f"Unknown tool: {fn_name}"
                    messages.append({"role": "tool", "tool_call_id": tc_id, "content": err})

        max_rounds_msg = "Maximum call rounds reached." if self._locale == "en" else "已达到最大调用轮次。"
        yield _sse("assistant_message", {"content": max_rounds_msg, "done": True})

    async def _tool_search_gallery(self, args: dict) -> str:
        query = args.get("query", "")
        top_k = args.get("top_k", 3)
        try:
            results = await self.gallery.search(query, top_k)
            if not results:
                return json.dumps({"found": 0, "items": []}, ensure_ascii=False)
            items = [
                {"id": r.id, "name": r.name, "score": round(r.score, 3)}
                for r in results[:top_k]
            ]
            return json.dumps({"found": len(items), "items": items}, ensure_ascii=False)
        except Exception as e:
            logger.warning("Gallery search failed: %s", e)
            return json.dumps({"error": str(e)}, ensure_ascii=False)

    def _extract_dominant_canvas_image(self) -> str | None:
        if not self._canvas_images:
            return None
        largest = max(self._canvas_images.values(), key=len, default=None)
        if largest and len(largest) > 100:
            return largest
        return None

    def _merge_back_metadata(self, modified_xml: str) -> str:
        full = self._canvas_skeleton_full
        if not full:
            return modified_xml

        try:
            full_tree = ET.fromstring(full)
        except ET.ParseError:
            return modified_xml

        nanadraw_attrs = (
            "nanadraw_visual_repr",
            "nanadraw_style_notes",
            "nanadraw_name",
            "nanadraw_category",
        )
        image_cell_style = (
            "html=1;overflow=fill;whiteSpace=wrap;"
            "verticalAlign=middle;align=center;"
            "fillColor=none;strokeColor=none;"
        )

        meta_map: dict[str, dict[str, str]] = {}
        for tag in ("UserObject", "object"):
            for elem in full_tree.iter(tag):
                eid = elem.get("id", "")
                if not eid:
                    continue
                attrs = {a: elem.get(a, "") for a in nanadraw_attrs}
                if attrs["nanadraw_visual_repr"] or attrs["nanadraw_style_notes"]:
                    meta_map[eid] = attrs
                    name = attrs.get("nanadraw_name")
                    if name:
                        meta_map[f"__name__{name}"] = attrs

        if not meta_map:
            return modified_xml

        try:
            mod_tree = ET.fromstring(modified_xml)
        except ET.ParseError:
            return modified_xml

        merged = 0
        for tag in ("UserObject", "object"):
            for elem in mod_tree.iter(tag):
                eid = elem.get("id", "")
                name = elem.get("nanadraw_name", "")

                meta = meta_map.get(eid)
                if not meta and name:
                    meta = meta_map.get(f"__name__{name}")
                if not meta:
                    continue

                for attr_key in nanadraw_attrs:
                    if attr_key not in elem.attrib and meta.get(attr_key):
                        elem.set(attr_key, meta[attr_key])
                        merged += 1

                img_ref = elem.get("image", "")
                if img_ref.startswith("nanadraw://img/") and "label" not in elem.attrib:
                    elem.set(
                        "label",
                        f'<img src="{img_ref}" width="100%" height="100%"/>',
                    )
                    del elem.attrib["image"]
                    merged += 1

                    for cell in elem.iter("mxCell"):
                        style = cell.get("style", "")
                        if not style or "html=1" not in style:
                            cell.set("style", image_cell_style)
                            merged += 1

        if mod_tree.tag == "mxGraphModel" and full_tree.tag == "mxGraphModel":
            for key, val in full_tree.attrib.items():
                if key not in mod_tree.attrib:
                    mod_tree.set(key, val)
                    merged += 1

        if merged > 0:
            logger.info(
                "[assistant user=%s] Merged %d metadata attributes back into modified XML",
                self.username,
                merged,
            )
            return ET.tostring(mod_tree, encoding="unicode")
        return modified_xml

    def _auto_restore_image_cells(self, modified_xml: str, lost_refs: set[str]) -> str:
        full = self._canvas_skeleton_full
        if not full:
            return modified_xml

        try:
            full_tree = ET.fromstring(full)
            mod_tree = ET.fromstring(modified_xml)
        except ET.ParseError:
            return modified_xml

        mod_root = mod_tree.find(".//root")
        if mod_root is None:
            return modified_xml

        restored = 0
        existing_ids = {e.get("id") for e in mod_tree.iter() if e.get("id")}

        for tag in ("UserObject", "object"):
            for elem in full_tree.iter(tag):
                eid = elem.get("id", "")
                if eid in existing_ids:
                    continue
                elem_str = ET.tostring(elem, encoding="unicode")
                if any(ref in elem_str for ref in lost_refs):
                    mod_root.append(elem)
                    existing_ids.add(eid)
                    restored += 1

        if restored > 0:
            logger.info(
                "[assistant user=%s] Auto-restored %d image cells from original skeleton",
                self.username,
                restored,
            )
            return ET.tostring(mod_tree, encoding="unicode")
        return modified_xml

    async def _tool_modify_canvas(self, args: dict) -> str:
        modified_xml = args.get("modified_xml", "")
        summary = args.get("summary", "画布修改")

        if not modified_xml or not modified_xml.strip():
            return "ERROR: modified_xml is empty."

        if self._img_placeholder_map:
            for ph, full_ref in self._img_placeholder_map.items():
                modified_xml = modified_xml.replace(ph, full_ref)

        try:
            ET.fromstring(modified_xml)
        except ET.ParseError as e:
            logger.warning("modify_canvas: invalid XML from LLM: %s", e)
            return f"ERROR: The modified XML is invalid: {e}. Please fix and retry."

        if "<root" not in modified_xml:
            return "ERROR: modified_xml must contain <root> element."
        if "<mxGraphModel" not in modified_xml and "<mxfile" not in modified_xml:
            return "ERROR: modified_xml must be an mxGraphModel or mxfile document."

        if self._canvas_skeleton:
            orig_refs = set(re.findall(r"nanadraw://img/[a-f0-9]{64}", self._canvas_skeleton))
            new_refs = set(re.findall(r"nanadraw://img/[a-f0-9]{64}", modified_xml))
            lost = orig_refs - new_refs
            if lost:
                logger.warning(
                    "[assistant user=%s] modify_canvas: %d/%d image refs lost, auto-restoring",
                    self.username,
                    len(lost),
                    len(orig_refs),
                )
                modified_xml = self._auto_restore_image_cells(modified_xml, lost)

        if self._canvas_skeleton:
            orig_cells = len(re.findall(r"<mxCell\b", self._canvas_skeleton))
            new_cells = len(re.findall(r"<mxCell\b", modified_xml))
            if orig_cells > 0 and new_cells < orig_cells * 0.3:
                logger.warning(
                    "[assistant user=%s] modify_canvas: significant cell loss (orig=%d, new=%d).",
                    self.username,
                    orig_cells,
                    new_cells,
                )
                return (
                    f"ERROR: Too many elements were lost (original: {orig_cells}, "
                    f"modified: {new_cells}). You MUST preserve all existing elements. "
                    "Please output the COMPLETE mxGraphModel with all cells."
                )

        modified_xml = self._merge_back_metadata(modified_xml)

        logger.info(
            "[assistant user=%s] Canvas modified: %s (xml_len=%d)",
            self.username,
            summary,
            len(modified_xml),
        )
        return _sse("canvas_update", {"xml": modified_xml, "summary": summary})

    def _build_generate_request(self, args: dict) -> GenerateRequest:
        text = args.get("text", "")
        mode_str = args.get("mode", "full_gen")
        style_ref_id = args.get("style_ref_id") or self._style_ref_id
        color_scheme = args.get("color_scheme", "pastel")
        image_model = args.get("image_model")

        image_only = mode_str == "image_only"
        canvas_type = args.get("canvas_type") or self._canvas_type

        if mode_str == "draft":
            gen_mode = GenerateMode.FAST
        else:
            gen_mode = GenerateMode.FULL_GEN

        style_spec: StyleSpec | None = None
        if not style_ref_id:
            desc = args.get("style_description")
            if desc:
                style_spec = StyleSpec(description=desc)

        sketch_b64 = args.get("sketch_image") or self._sketch_image_b64

        if image_only and not sketch_b64 and self._last_result_image_b64:
            sketch_b64 = self._last_result_image_b64
            logger.info(
                "[assistant user=%s] Auto-injecting last result image as sketch for image_only adjustment",
                self.username,
            )

        return GenerateRequest(
            text=text,
            mode=gen_mode,
            style_ref_id=style_ref_id,
            style_spec=style_spec,
            options=GenerateOptions(
                color_scheme=color_scheme,
                image_model=image_model,
                component_image_model=self.component_image_model_override,
                image_only=image_only,
                canvas_type=canvas_type,
            ),
            sketch_image_b64=sketch_b64,
        )

    async def _tool_generate_diagram(
        self,
        args: dict,
        *,
        nana_soul: str | None,
    ) -> AsyncGenerator[str, None]:
        self._last_pipeline_failed = False
        self._last_pipeline_error = ""
        ref_source = args.pop("reference_source", None)

        if ref_source == "current_canvas":
            img = self._extract_dominant_canvas_image()
            if img:
                self._last_result_image_b64 = img
                logger.info(
                    "[assistant user=%s] Using current canvas image as reference (%d chars)",
                    self.username,
                    len(img),
                )
        elif ref_source == "last_result":
            pass

        mode_str = args.get("mode", "full_gen")
        request_id = uuid.uuid4().hex[:12]
        request = self._build_generate_request(args).model_copy(update={"request_id": request_id})

        try:
            if mode_str == "draft":
                from app.services.pipeline.orchestrator import PipelineOrchestrator

                orch = PipelineOrchestrator(
                    username=self.username,
                    task_id=request_id,
                    nana_soul=nana_soul,
                )
                async for event in orch.run(request):
                    img = _parse_result_image_from_sse(event)
                    if img:
                        self._last_result_image_b64 = img
                    yield event
                await orch.cleanup()
            else:
                from app.services.pipeline.fullgen_orchestrator import FullGenOrchestrator

                orch = FullGenOrchestrator.get_or_create(request_id, username=self.username)
                orch.nana_soul = nana_soul
                async for event in orch.run(request):
                    img = _parse_result_image_from_sse(event)
                    if img:
                        self._last_result_image_b64 = img
                    yield event
                await orch.cleanup()
        except Exception as e:
            logger.exception("Inline pipeline failed")
            self._last_pipeline_failed = True
            self._last_pipeline_error = str(e)
            yield _sse("error", {"message": str(e)})
            yield _sse("close", {})

    async def _tool_generate_assets(self, args: dict) -> AsyncGenerator[str, None]:
        import asyncio
        from app.core.config import settings
        from app.services.pipeline.image_processor import ImageProcessor

        NUM_VARIANTS = 3

        descriptions = args.get("descriptions", [])[:1]
        style_str = args.get("style", "minimal_flat")
        style_name = str(style_str).replace("_", " ")
        style_description = STYLE_DESCRIPTIONS.get(style_str, STYLE_DESCRIPTIONS["minimal_flat"])

        descs = [d.strip() for d in descriptions if isinstance(d, str) and d.strip()]
        if not descs:
            yield _sse("error", {"message": "No asset descriptions provided."})
            yield _sse("close", {})
            return

        desc = descs[0]
        total = NUM_VARIANTS
        yield _sse("asset_start", {"total": total})

        image_model = (
            self.component_image_model_override
            or self.image_model_override
            or str(get_setting("llm_image_model") or "").strip()
            or settings.LLM_COMPONENT_MODEL
            or settings.LLM_IMAGE_MODEL_FLASH
            or settings.LLM_IMAGE_MODEL
        )

        user_prompt = ASSET_GEN_USER.format(
            description=desc,
            style_name=style_name,
            style_description=style_description,
        )

        async def _gen_one(variant_idx: int) -> tuple[int, str | None, str | None]:
            llm = LLMService()
            llm.log_tag = f"[assistant-asset-v{variant_idx} user={self.username}] "
            llm.image_model = image_model
            try:
                image_b64 = await llm.generate_image(
                    ASSET_GEN_SYSTEM, user_prompt,
                    temperature=0.7 + variant_idx * 0.1,
                )
                try:
                    image_b64 = await ImageProcessor.ensure_transparent(
                        image_b64, prefer_edge_flood=True,
                    )
                except Exception:
                    pass
                return (variant_idx, image_b64, None)
            except Exception as e:
                logger.warning("Asset gen variant %d failed for %r: %s", variant_idx, desc, e)
                return (variant_idx, None, str(e))
            finally:
                await llm.close()

        tasks = [_gen_one(i) for i in range(NUM_VARIANTS)]
        results = await asyncio.gather(*tasks)

        images: list[dict[str, str]] = []
        for idx, img_b64, err in sorted(results, key=lambda r: r[0]):
            if img_b64:
                images.append({"description": desc, "image_b64": img_b64})
                yield _sse("asset_progress", {
                    "index": idx + 1, "total": total,
                    "description": desc, "image_b64": img_b64,
                    "status": "success",
                })
            else:
                yield _sse("asset_progress", {
                    "index": idx + 1, "total": total,
                    "description": desc, "status": "failed",
                    "error": err or "unknown",
                })

        yield _sse("asset_complete", {
            "total": total,
            "success": len(images),
            "failed": total - len(images),
        })
        yield _sse("asset_results", {"images": images, "style": style_str})
        yield _sse("close", {})

    # ── Component regeneration (bypasses LLM tool-calling loop) ──

    REGEN_SYSTEM = (
        "You are an expert icon and illustration designer. "
        "The user wants to regenerate a specific component in their diagram.\n\n"
        "CANVAS: The output image MUST be SQUARE (1:1 aspect ratio). "
        "Target 4096×4096 pixels.\n\n"
        "Rules:\n"
        "- Output EXACTLY ONE image per request.\n"
        "- The image MUST have a CLEAN, SOLID WHITE or TRANSPARENT background.\n"
        "- HIGH CONTRAST between subject and background.\n"
        "- Leave generous padding (≥15px each side) around the subject.\n"
        "- The subject should be centered.\n"
        "- Do NOT add any text, labels, watermarks, or frames.\n"
        "- Edges MUST be crisp and well-defined for clean background removal.\n"
        "- Use solid, saturated colors INSIDE the subject — avoid white or near-white fills.\n"
        "- ABSOLUTELY NO colored backgrounds or gradient fills OUTSIDE the subject.\n"
    )

    REGEN_USER_TEMPLATE = (
        "Component name: {label}\n"
        "{visual_repr_section}"
        "User modification request: {user_instruction}\n\n"
        "Regenerate this diagram component as a clean, isolated icon/illustration "
        "on a SQUARE white canvas (1:1 aspect ratio, target 4096×4096 pixels). "
        "No text, no labels, no decorative borders. "
        "The component should be clearly recognizable and suitable for use "
        "in an academic pipeline/architecture diagram."
    )

    async def _handle_regen_component(
        self,
        user_message: str,
        regen_ctx: dict,
    ) -> AsyncGenerator[str, None]:
        from app.core.config import settings as app_settings
        from app.services.pipeline.image_processor import ImageProcessor

        component_id = regen_ctx.get("component_id", "")
        label = regen_ctx.get("component_label", component_id)
        visual_repr = regen_ctx.get("visual_repr") or ""
        ref_image_b64 = regen_ctx.get("component_image_b64") or None
        en = self._locale == "en"

        num_variants = 2

        pre_msg = (
            f"Got it~ 🎨 Regenerating component **{label}** using the component model, "
            f"generating {num_variants} variants for you to choose from~ ✨"
            if en else
            f"收到啦~ 🎨 正在使用**组件生成模型**重新生成组件「{label}」，"
            f"将为你生成 {num_variants} 个备选方案哦~ ✨"
        )
        yield _sse("assistant_message", {"content": pre_msg, "done": False})
        yield _sse("regen_start", {"component_id": component_id, "total": num_variants})

        llm = LLMService()
        llm.log_tag = f"[regen user={self.username}] "
        llm.image_model = (
            self.component_image_model_override
            or self.image_model_override
            or str(get_setting("llm_component_model") or "").strip()
            or str(get_setting("llm_image_model") or "").strip()
            or app_settings.LLM_COMPONENT_MODEL
            or app_settings.LLM_IMAGE_MODEL_FLASH
            or app_settings.LLM_IMAGE_MODEL
        )
        logger.info(
            "[regen user=%s] component=%s label=%s model=%s ref_image=%s",
            self.username, component_id, label, llm.image_model,
            "yes" if ref_image_b64 else "no",
        )

        visual_repr_section = ""
        if visual_repr:
            visual_repr_section = f"Original visual description: {visual_repr}\n"

        user_prompt = self.REGEN_USER_TEMPLATE.format(
            label=label,
            visual_repr_section=visual_repr_section,
            user_instruction=user_message,
        )

        images: list[dict[str, str]] = []
        try:
            for i in range(num_variants):
                try:
                    image_b64 = await llm.generate_image(
                        self.REGEN_SYSTEM,
                        user_prompt,
                        temperature=0.8 + i * 0.1,
                        reference_image_b64=ref_image_b64,
                    )
                    try:
                        image_b64 = await ImageProcessor.ensure_transparent(
                            image_b64,
                            prefer_edge_flood=True,
                        )
                    except Exception:
                        pass
                    images.append({"description": label, "image_b64": image_b64})
                    yield _sse("regen_progress", {
                        "completed": i + 1,
                        "total": num_variants,
                    })
                except Exception as e:
                    logger.warning("Regen variant %d failed for %r: %s", i + 1, label, e)

            if images:
                yield _sse("regen_results", {
                    "component_id": component_id,
                    "images": images,
                    "total": num_variants,
                    "success": len(images),
                })
                done_msg = (
                    f"Here are {len(images)} variant(s) for **{label}** — "
                    "pick the one you like and click to apply! ✨"
                    if en else
                    f"组件「{label}」的 {len(images)} 个备选方案已生成~ "
                    "选择你喜欢的点击应用到画布吧！✨"
                )
            else:
                yield _sse("regen_error", {
                    "message": "All variants failed" if en else "所有备选方案生成失败",
                })
                done_msg = (
                    f"Sorry, all regeneration attempts for **{label}** failed. "
                    "Please try again later."
                    if en else
                    f"抱歉，组件「{label}」的所有重生成尝试都失败了，请稍后再试。"
                )
            yield _sse("assistant_message", {"content": done_msg, "done": True})
        finally:
            await llm.close()
        yield _sse("close", {})
