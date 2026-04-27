<div align="center">

<img src="image/NanaDraw_logo.jpg" alt="NanaDraw logo" width="220">

# NanaDraw

**Turn academic paper method descriptions into editable pipeline diagrams**

[简体中文](./README_zh-CN.md) | English

[Video](https://www.youtube.com/watch?v=_awu_jQiSFQ)

👋 join us on [WeChat](./docs/material/wechat_group_qr.jpg)


</div>

## Features

- 📝 Paste method description text → auto-generate pipeline diagrams
- 📄 Upload paper PDFs, parse them with MinerU, and quote selected text for drawing prompts
- 🎨 Three creation modes: Draft, Generation, and Assembly
- 🖼️ Built-in style gallery with 250+ academic paper reference images
- 🧰 Asset workshop with Bioicons, reusable personal assets, and AI-generated materials
- ✏️ Integrated draw.io editor for diagram fine-tuning
- 🤖 AI Assistant (NanaSoul) for natural language canvas manipulation
- 💾 Local project storage — no cloud required
- 🌐 Bilingual UI (Chinese/English)

### Example Scenario

Upload a hand-drawn sketch and turn it into a high-fidelity editable pipeline diagram in one click.

| Input Sketch | Editable Output |
|--------------|-----------------|
| <img src="image/handwrite.jpg" alt="Hand-drawn sketch example" width="420"> | <img src="image/pipeline.png" alt="Editable pipeline diagram example" width="420"> |

Figure 1 shows the rough hand-drawn sketch. Figure 2 shows the generated high-fidelity editable workflow diagram.

### PDF Parsing and Quoted-Selection Drawing

Upload a PDF in the AI Workbench and NanaDraw will call the MinerU online API to parse the document into Markdown. The parsed result appears in a scrollable, collapsible floating panel on the left side of the workbench. You can select a method paragraph, experiment flow, or paper-structure passage, click "Quote selection", enrich the prompt in your own words, and then continue through NanaDraw's existing generation flow.

- PDF upload is available in Draft, Generation, Assembly, and Auto modes.
- PDF content is sent only to MinerU for document parsing; NanaDraw does not automatically send the whole paper to the LLM.
- Only the text explicitly quoted by the user is merged into the generation prompt.

### Creation Modes

| Mode | Description | Steps | Example Screenshot |
|------|-------------|-------|--------------------|
| Draft Mode | Editable XML sketch from text or hand-drawn input | 2 (Plan → XML) | [View screenshot](./image/draft_mode.jpg) |
| Generation Mode | Direct visual concept image for inspiration and preview | 2 (Plan → Image) | [View screenshot](./image/generation_mode.jpg) |
| Assembly Mode | Editable, style-aware illustration built through structured assembly | 5 (Plan → Image → Blueprint → Components → Assembly) | [View screenshot](./image/assembly_mode.jpg) |

### Mode Gallery

**Draft Mode**

<img src="image/draft_mode.jpg" alt="Draft Mode screenshot" width="760">

**Generation Mode**

<img src="image/generation_mode.jpg" alt="Generation Mode screenshot" width="760">

**Assembly Mode**

<img src="image/assembly_mode.jpg" alt="Assembly Mode screenshot" width="760">

### Draft Mode

Turn text descriptions or uploaded hand-drawn sketches into editable XML drafts quickly.

- Best when an idea has just appeared and you want to get it onto the canvas first.
- Enter a method description, a few keywords, or a rough concept, and NanaDraw produces an editable first-pass sketch.
- Think of it as a creative whiteboard: block out the structure now, then refine details, hierarchy, and wording later.
- Useful for brainstorming, rapid outlining, method mapping, and comparing alternative concepts.

### Generation Mode

Use the Nano Banana model family to generate a complete visual concept image for posters, inspiration, or fast previews.

- Best when you want a compelling result from a single sentence or a short prompt.
- Provide a topic, structural hints, and style preferences, and the system creates a full visual composition directly.
- This mode emphasizes visual impact, overall atmosphere, and creative expression.
- When you are not sure how the final figure should look yet, it can give you several strong directions to react to.

### Assembly Mode

Run NanaDraw's structured assembly pipeline to generate an editable visual illustration that can also be exported to PPT for further refinement.

- Best for formal figures that need to look polished while staying precise and controllable.
- The system first understands the structural relationships in your description, then assembles modules, components, and layout step by step.
- This mode emphasizes accurate generation from the description while keeping module boundaries clear, structure tidy, and downstream editing easy.
- It balances creativity with the clarity and consistency expected in paper figures, architecture diagrams, and multi-stage workflows.
- If Generation Mode feels like an idea burst, Assembly Mode is the stage where that idea is refined into something ready to present or publish.

### Asset Workshop

The built-in asset workshop combines Bioicons, user-managed assets, and AI-generated materials.

- It works like a ready-to-use parts library, so you do not have to start every figure from zero.
- You can build your own reusable collection of icons, components, and visual elements that becomes more useful over time.
- AI asset generation lets you describe what you want or provide a reference direction to create new icons, illustrations, and reusable visual components.
- When generic icons are not enough or existing assets do not match the idea closely, the workshop turns "what I want" into "what I can use right now."

### Gallery & Icons

- **Gallery**: Download reference images: `python scripts/download_gallery.py`
- **Bioicons**: Download SVG icons: `python scripts/download_bioicons.py`

Both are optional and will be prompted during first startup.

## Install & Deploy

### Prerequisites

- Python >= 3.10
- Node.js >= 18
- pnpm (`npm install -g pnpm`)
- An LLM API key (Gemini, OpenAI, or compatible)

### One-Click Start

```bash
git clone https://github.com/Shannon4Science/NanaDraw.git
cd NanaDraw
python start.py
```

The script will:
1. Install Python and Node.js dependencies
2. Optionally download gallery images and bioicons
3. Build the frontend
4. Start the server and open your browser

### Background Running

> **Note**: For first-time use, run `python start.py` in the foreground to complete interactive steps such as dependency installation and asset downloads. Once initialization is done, subsequent launches can use background mode:

```bash
nohup python start.py --skip-download > nanadraw.log 2>&1 &
```

`--skip-download` skips the interactive data download prompts, preventing the background process from hanging on user input. To download assets separately, run in the foreground:

```bash
python scripts/download_gallery.py
python scripts/download_bioicons.py
```

View the log at any time with `tail -f nanadraw.log`. To stop the process, find the PID and kill it:

```bash
kill $(cat nanadraw.pid 2>/dev/null || ps aux | grep 'start.py' | grep -v grep | awk '{print $2}')
```

### Development Mode

```bash
python start.py --dev
```

This starts both the Vite dev server and the backend API server.

### Configuration

After starting, click the ⚙️ gear icon in the top-right corner to configure:

- **API Key**: Your LLM provider API key
- **API Base URL**: Custom endpoint (leave empty for default)
- **Text Model**: Default `gemini-3.1-pro-preview`
- **Image Model**: Default `gemini-3-pro-image-preview`
- **Component Model**: Default `gemini-3.1-flash-image-preview`
- **NanaSoul**: Custom AI persona for style constraints
- **Document Parsing Token**: MinerU online API token for PDF parsing

#### Data Directory (Environment Variable)

NanaDraw stores projects, assets, and settings in a local data directory. The default path is `~/.nanadraw`, and you can override it with `NANADRAW_DATA_DIR`:

```bash
# macOS / Linux
export NANADRAW_DATA_DIR="$HOME/nanadraw-data"
python start.py
```

```powershell
# Windows PowerShell
$env:NANADRAW_DATA_DIR="$HOME\\nanadraw-data"
python start.py
```

## Architecture

```
NanaDraw/
├── frontend/          # React + TypeScript + Vite + TailwindCSS
│   └── src/
├── backend/           # FastAPI + Python
│   ├── app/
│   │   ├── api/       # REST API endpoints
│   │   ├── services/  # Business logic + pipeline orchestration
│   │   ├── prompts/   # LLM prompt templates
│   │   └── static/    # Gallery + Bioicons data
│   └── requirements.txt
├── drawio/            # draw.io fork (Apache-2.0)
├── scripts/           # Data download scripts
└── start.py           # One-click startup
```

## Contributing

<!-- TODO: Add contribution guidelines -->

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

This project is licensed under a modified Apache License 2.0 with additional conditions. See the [LICENSE](./LICENSE) file for details. ([中文版](./LICENSE_zh-CN))

The draw.io fork is licensed under Apache-2.0.

## Acknowledgments

- [draw.io](https://github.com/jgraph/drawio) — Diagram editor
- [Bioicons](https://github.com/duerrsimon/bioicons) — Science SVG icons
- [PaperGallery](https://github.com/LongHZ140516/PaperGallery) — Reference images
