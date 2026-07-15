# ST Card Editor — SillyTavern Character Card Studio

A web-based tool for editing, translating, and enhancing **SillyTavern character cards** with AI assistance. Drag & drop your cards, edit every field, generate characters with AI, and get reference images — all in one place.

### **[Try it now](https://maxime-fleury.github.io/ST-cardEditor/)**

![Version](https://img.shields.io/badge/version-2.2.0-purple)
![Runtime](https://img.shields.io/badge/runtime-Bun-000?logo=bun)
![License](https://img.shields.io/badge/license-MIT-blue)
[![Live Demo](https://img.shields.io/badge/demo-gh--pages-9147ff?logo=githubpages)](https://maxime-fleury.github.io/ST-cardEditor/)
[![Deploy](https://github.com/maxime-fleury/ST-cardEditor/actions/workflows/deploy.yml/badge.svg)](https://github.com/maxime-fleury/ST-cardEditor/actions/workflows/deploy.yml)

---

## Screenshots

| Landing Page (Dark) | Character Wizard |
|:---:|:---:|
| ![Landing Dark](.github/screenshots/01-landing-dark.png) | ![Wizard Step 1](.github/screenshots/03-wizard-step1.png) |

| Editor (Core) | Editor (Advanced) |
|:---:|:---:|
| ![Editor Populated](.github/screenshots/07-editor-populated.png) | ![Editor Advanced](.github/screenshots/09-editor-advanced.png) |

| Settings | Full View (Dark) |
|:---:|:---:|
| ![Settings](.github/screenshots/10-settings.png) | ![Full Dark](.github/screenshots/11-full-dark.png) |

---

## Features

### Card Library
- **Drag & drop** loading of `.png`, `.webp`, and `.json` SillyTavern character cards
- Automatic parsing of embedded card data from PNG/WebP files (`chara` and `ccv3` chunks)
- Visual card library with avatars, names, creators, tags, and file size display
- Stable card identification via content hashing
- **3D tilt effect** on card hover (respects `prefers-reduced-motion`)
- **Tag cloud** with click-to-filter across all cards (AND logic)
- **6 sort modes:** name, newest/oldest, largest/smallest
- **Batch operations:** multi-select for bulk delete, bulk JSON export, and **card comparison** (side-by-side JSON diff)
- **Drag-to-reorder** cards in the library
- **Workspace backup/restore** — export/import your entire card library and settings as a single file

### Full Card Editor
Four tabbed panels covering every aspect of the **V2/V3 card spec**:

| Tab | Fields |
|-----|--------|
| **Core** | Name, Description, First Message, Scenario, Creator, Version, Tags |
| **Personality** | Personality Summary, Example Messages |
| **Advanced** | System Prompt, Post-History Instructions, Creator Notes, Alternate Greetings |
| **Lorebook** | Full character lorebook entry management |

- **Undo/Redo** per field (up to 50 snapshots)
- **Character & token counts** per field
- **Markdown preview** toggle for any textarea
- **Auto-resize** textareas (up to 800px)
- **Alternate greetings** — add, reorder, set default, delete
- **Lorebook entries** — keywords, content, order, constant/selective flags, position
- **Delete confirmation** — prevents accidental card deletion with a confirm dialog

### AI Assistant

**Seven built-in provider modes:**

| Provider | Description |
|----------|-------------|
| **OpenRouter** | 200+ hosted models with pricing, free tier available |
| **NanoGPT** | Hosted models via nano-gpt.com |
| **xAI (Grok)** | Grok models from xAI |
| **Z.AI (GLM)** | ZhipuAI GLM models |
| **Chutes** | Hosted models via Chutes AI |
| **DeepSeek** | DeepSeek models (V3, R1, etc.) |
| **Custom** | LM Studio, Ollama, vLLM, or any OpenAI-compatible endpoint |

- **Streaming responses** with real-time text rendering
- **Side-by-side diff preview** — review AI changes before applying (uses [jsdiff](https://github.com/kpdecker/jsdiff))
- **Re-apply button** — re-open the diff modal for any past AI response (no more losing changes when you close the modal)
- **Auto-apply** AI responses to targeted card fields
- **Quick actions** — one-click presets:
  - New Card (wizard), Translate, Enhance Description, Expand Personality, Improve First Message, Shorten, Adjust Tone, Fix Grammar
- **Multi-field parallel editing** — select multiple fields and edit them simultaneously in one AI request
- **Field chip selector** — visual toggle for targeting specific fields or the full card
- **Context bar** — accurate token usage vs. context window with progress indicator
- **Chat history** — persisted per card across sessions with session management
- **Cost display** — shows token usage and estimated cost per message

### Card Creation Wizard

A 5-step guided character builder:

| Step | Fields |
|------|--------|
| **Basics** | Name, gender/pronouns, tags, creator |
| **Concept** | Character type (Original, Fanfic, Game, Anime, etc.), language (English, French, German, Japanese, Other), genre chips (15 options), mood chips (12 options) |
| **Personality** | Personality traits, appearance, special abilities |
| **Scenario** | Setting, relationship to `{{user}}`, opening vibe chips (6 options), notes |
| **Generate** | Summary review, reference image, generate with AI or create blank |

- **Multi-select chip groups** for genres, moods, and opening vibe
- **Custom inputs** for gender and language
- **Reference image** — fetch 3 anime-style images from [waifu.im](https://www.waifu.im), select one, refetch unselected, apply as card avatar
- **AI generation** — builds a detailed prompt from all wizard answers and sends to AI for full card generation
- **Blank generation** — creates a card with name/tags/creator and selected image pre-filled
- **Wizard thumbnail** — selected image automatically becomes the card thumbnail in the library

### Animations & Micro-Interactions

Powered by [anime.js](https://animejs.com/) with full `prefers-reduced-motion` support:

- **Wizard transitions** — slide-in/out between steps, staggered field entrance, progress bar bounce
- **Card list** — staggered fade-in after render, drag start/end scale+opacity feedback
- **Theme toggle** — 360° icon spin on switch
- **Button feedback** — scale(0.96) click animation on all buttons via mousedown
- **Toast notifications** — horizontal slide entrance with countdown timer and undo support
- **AI chat** — message entrance animation, quick action stagger on clear
- **Lorebook** — spring-like chevron rotation on toggle
- **Brand icon** — idle floating animation
- **Skeleton loading** — staggered reveal for card placeholders
- **Saved indicator** — brief "✓ Saved" flash on the save button after each auto-save

### Localization (i18n)

Full interface translation across **10 languages** with 340+ translation keys:

| Language | Key | Status |
|----------|-----|--------|
| English | `en` | Default |
| French | `fr` | Complete |
| Spanish | `es` | Complete |
| German | `de` | Complete |
| Portuguese (Brazil) | `pt-BR` | Complete |
| Japanese | `ja` | Complete |
| Chinese (Simplified) | `zh` | Complete |
| Korean | `ko` | Complete |
| Greek | `el` | Complete |
| Russian | `ru` | Complete |

- **Auto-detection** from browser language (`navigator.language`)
- **Manual switch** via Settings modal — changes apply instantly
- **Persistent** via `localStorage`
- Covers: navbar, card library, editor tabs, AI chat, wizard, settings, toasts, modals, error messages
- Formal/polite register for all languages (Japanese です/ます, German Sie-form, formal Korean, formal Russian)

### Storage & Export
- **Auto-save** to browser localStorage + IndexedDB with debounced writes
- **Export as JSON** — clean, formatted card data
- **Export as PNG** — embeds card data into a valid PNG (SillyTavern-compatible)
- Auto-generated fallback avatar PNG for cards without images
- Storage usage monitor
- Settings import/export
- **Full workspace backup** — export/import all cards and settings as a single JSON file

### Design & UX
- **Dark purple theme** (default) and **light theme** with one-click toggle
- Custom scrollbars, smooth transitions, and micro-interactions
- Toast notifications for all actions with countdown timers
- **Global error boundary** — catches unhandled errors and shows user-friendly toasts
- **Keyboard shortcuts** (`Ctrl+S` save, `Ctrl+N` new card, `Ctrl+Z/Y` undo/redo)
- **Modal focus traps** — keyboard navigation stays inside open modals
- **Delete confirmation** — prevents accidental card deletion
- Fully responsive layout (adapts to tablet and mobile)
- Resizable panels with drag handles
- **Offline support** via service worker (caches app shell for instant loading)
- Content-Security-Policy headers for production security

---

## Getting Started

### Prerequisites

- **[Bun](https://bun.sh)** runtime (v1.0+)

### Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone the repository
git clone https://github.com/maxime-fleury/ST-cardEditor.git
cd st-card-editor

# Start the dev server (with file watching)
bun run dev

# Or start in production mode
bun run start
```

The app will be available at **http://localhost:8182**.

Or try it instantly on **GitHub Pages**:

[**https://maxime-fleury.github.io/ST-cardEditor/**](https://maxime-fleury.github.io/ST-cardEditor/)

### AI Provider Setup

#### Option A: OpenRouter (hosted models)
1. Go to [OpenRouter.ai/keys](https://openrouter.ai/keys)
2. Create an account and generate an API key
3. Open Settings (gear icon) and paste the key
4. Click **Refresh Models** to load available AI models
5. Select your preferred model from the navbar dropdown

#### Option B: Named Providers (NanoGPT, xAI, Z.AI, Chutes, DeepSeek)
1. Open Settings (gear icon) and select your provider
2. Click the provider link to get an API key
3. Paste the API key and enter a Model ID
4. Click **Refresh Models** to load available models

#### Option C: Custom Provider (local models)
1. Start your local server (e.g., LM Studio, Ollama)
2. Open Settings (gear icon) and select **Custom (OpenAI-compatible)**
3. Enter the API Base URL (e.g. `http://localhost:1234/v1`)
4. Enter the Model ID your server expects
5. Leave API Key empty for local providers
6. Click **Refresh Models** to auto-detect available models

---

## Usage

### Loading Cards
- **Drag & drop** any `.png`, `.webp`, or `.json` file onto the left panel's drop zone
- Click **Browse files** to select cards via the file picker
- Multiple cards can be loaded at once

### Editing
1. Click a card in the library to select it
2. Edit any field across the four tabs
3. Changes auto-save (debounced) — a "✓ Saved" indicator flashes on the Save button
4. Use **JSON / PNG** export buttons to download the finished card

### Creating a New Character
1. Click the wizard button (star icon in navbar, or center button on empty state)
2. Step through the 5 tabs filling in character details
3. Optionally fetch a reference image from waifu.im
4. Choose **Generate with AI** (requires API key) or **Create Blank Card**
5. The selected image becomes the card's avatar and thumbnail automatically

### AI Editing
1. Select target fields using the chip selector below the chat input
2. Type a prompt (e.g., "Make this more mysterious and aloof")
3. Press **Enter** or click the send button
4. Review the side-by-side diff preview and click **Apply Changes**
5. If you close the modal without applying, click **Re-apply** on the assistant message to re-open the diff

### Quick Actions
Click any suggestion chip to instantly:
- New Card — opens the character creation wizard
- Translate — translates entire card to a chosen language
- Enhance Description — adds sensory details
- Expand Personality — adds quirks and motivations
- Improve First Message — makes it more engaging
- Shorten — tightens text while preserving meaning
- Change Tone — rewrites with a specified tone
- Fix Grammar — corrects grammar, spelling, and punctuation

### Card Comparison
1. Select exactly 2 cards using the batch checkboxes
2. Click the **Compare** button in the batch toolbar
3. View a side-by-side JSON diff of both cards

---

## Project Structure

```
st-card-editor/
├── public/
│   ├── index.html          # Main HTML with full UI layout
│   ├── sw.js               # Service worker for offline app-shell caching
│   └── css/                # Stylesheets (split by concern)
│       ├── theme.css        # Design tokens, dark/light themes, backdrop
│       ├── base.css         # Reset, scrollbars, navbar, animations, buttons
│       ├── layout.css       # App container, panels, resizers
│       ├── library.css      # Left panel: card list, drop zone, empty state
│       ├── editor.css       # Editor fields, textareas, markdown preview
│       ├── ai-assistant.css # AI chat panel and message bubbles
│       ├── modal.css        # Modals, model list, credits
│       ├── diff.css         # AI response diff viewer
│       ├── wizard.css       # Card creation wizard
│       ├── components.css   # Toasts, lorebook, greetings
│       └── responsive.css   # Media queries and responsive rules
├── js/
│   ├── cardEngine.js       # Card parsing, normalization, PNG chunk embedding
│   ├── aiService.js        # AI API client (7 providers + custom)
│   ├── storage.js          # localStorage + IndexedDB persistence layer
│   ├── exportUtils.js      # PNG/JSON export, CRC32, PNG chunk embedding
│   ├── editor.js           # Editor form, greetings, lorebook management
│   ├── cardManager.js      # Card list, selection, CRUD, sorting, tag cloud, batch compare, 3D tilt
│   ├── aiChat.js           # AI chat interface, streaming, diff, re-apply, quick actions
│   ├── wizard.js           # 5-step character creation wizard, waifu.im integration
│   ├── settings.js         # Settings modal, model list, credits, provider config, workspace backup
│   ├── tokenizer.js        # Token estimation (lazy-loaded BPE tokenizer)
│   ├── animations.js       # anime.js animation utilities (stagger, slide, pulse, etc.)
│   ├── i18n.js             # Internationalization: 340+ keys × 10 languages
│   └── ui.js               # Main controller: utilities, init, event binding, error boundary
├── .github/
│   ├── screenshots/        # README screenshots
│   └── workflows/
│       └── deploy.yml      # GitHub Pages CI/CD
├── server.js               # Bun static file server with OpenRouter API proxy + CSP headers
├── package.json            # Project metadata and scripts
└── README.md               # This file
```

### Architecture

The app is a **single-page application** built with vanilla JavaScript and **Bootstrap 5.3** for layout:

- **`cardEngine.js`** — Parses SillyTavern card formats (V1 flat, V2/V3 spec), extracts embedded data from PNG/WebP files (`chara`/`ccv3` tEXt chunks), and handles stable ID generation via content hashing.
- **`aiService.js`** — Wraps 7 AI providers (OpenRouter, NanoGPT, xAI, Z.AI, Chutes, DeepSeek, Custom) with a unified registry: lists models with pricing, sends chat completions (streaming and non-streaming) with context-aware system prompts, fetches account credit info, and includes request timeouts.
- **`storage.js`** — Hybrid persistence: lightweight metadata in `localStorage` (namespaced `stce_*`), full card data and images in **IndexedDB** (`stce_data` database). Includes one-time migration from legacy localStorage-only format.
- **`exportUtils.js`** — PNG/JSON export with CRC32 checksum calculation and `tEXt` chunk embedding for SillyTavern-compatible output.
- **`editor.js`** — Two-way binding between editor form fields and the active card object, with debounced auto-save, undo/redo, alternate greetings, and lorebook entry management.
- **`cardManager.js`** — Card library rendering, drag-and-drop file import, card selection with IndexedDB image loading, sorting, tag cloud filtering, batch operations (delete, export, compare), and 3D tilt hover effect.
- **`aiChat.js`** — AI chat interface with streaming responses, side-by-side diff preview (via jsdiff), re-apply button for past responses, markdown rendering (via marked + DOMPurify), context-aware system prompts, multi-field parallel editing, and quick action presets.
- **`wizard.js`** — 5-step guided character creation with chip-based multi-select inputs, summary review, waifu.im image fetching and selection, and AI generation with automatic thumbnail setup.
- **`settings.js`** — Settings modal with provider selection (7 providers), API key management, model browsing/selection, credit tracking, storage usage display, language switching, and full workspace backup/restore.
- **`tokenizer.js`** — Token estimation using lazy-loaded `gpt-tokenizer` BPE library with offline heuristic fallback.
- **`animations.js`** — Reusable animation functions built on anime.js: stagger fade-in, slide transitions, pulse, shake, scale click, progress bounce, icon spin, skeleton reveal, toast entrance. All respect `prefers-reduced-motion`.
- **`i18n.js`** — Internationalization module: `I18n.t(key, vars?)` with `{{var}}` interpolation, `translateDOM()` for batch element translation, auto-detection from browser language, manual switch via Settings. 340+ keys across 10 languages.
- **`ui.js`** — Thin controller: shared state (`AppState`), utility functions (`escapeHtml`, `debounce`, `showToast`, `renderMarkdown`), initialization, I18n boot, global error boundary, markdown library lazy-loading, and all event binding.

---

## Technical Details

### PNG Card Embedding

The app follows the SillyTavern convention of embedding card JSON inside the `tEXt` chunk of a PNG file with the keyword `chara` (or legacy `ccv3`). The `exportUtils.js` module creates PNGs with the embedded chunk placed right before the `IEND` chunk:

```
PNG Signature → IHDR → ... → IDAT → tEXt (chara=JSON) → IEND
```

### Supported Card Specs

- **V1 (flat)** — `{ name, description, personality, ... }` without `spec` field
- **V2/V3** — `{ spec: "chara_card_v2", spec_version: "2.0", data: { ... } }`

### CDN Libraries

| Library | Purpose |
|---------|---------|
| [marked](https://github.com/markedjs/marked) | Markdown parsing for AI chat messages (lazy-loaded) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | XSS sanitization of rendered HTML (lazy-loaded) |
| [jsdiff](https://github.com/kpdecker/jsdiff) | Word-level diffing for AI response preview |
| [anime.js](https://animejs.com/) | Animation library for micro-interactions |
| [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) | BPE token counting (lazy-loaded) |

### Theme System

Two themes via CSS custom properties:
- **Dark** (default) — Deep Obsidian & Cosmic Purple
- **Light** — Snowy Lavender & Pastel Violet

Toggle with the button in the navbar. Theme persists in localStorage.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save current card |
| `Ctrl+N` / `Cmd+N` | Create new blank card |
| `Ctrl+Z` / `Cmd+Z` | Undo last edit |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Enter` (in AI input) | Send message to AI |
| `Shift+Enter` (in AI input) | New line in AI input |
| `?` | Show keyboard shortcuts |

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests for:

- Additional card spec support
- More AI quick actions / presets
- Batch editing features
- Theme customization
- Additional languages

---

## CI/CD

Every push to the `master` branch automatically deploys the latest version to GitHub Pages via [GitHub Actions](.github/workflows/deploy.yml).

Check the [Actions tab](https://github.com/maxime-fleury/ST-cardEditor/actions) for deployment status.

---

## License

This project is open source and available under the [MIT License](LICENSE).

---

## Acknowledgments

- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — The amazing AI roleplay frontend these cards are made for
- **[OpenRouter](https://openrouter.ai)** — Multi-model API with generous free tier
- **[waifu.im](https://www.waifu.im)** — Anime image API for character reference images
- **[Bootstrap](https://getbootstrap.com)** — UI framework
- **[Bootstrap Icons](https://icons.getbootstrap.com)** — Icon set
- **[marked](https://github.com/markedjs/marked)** — Markdown parser
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — HTML sanitizer
- **[jsdiff](https://github.com/kpdecker/jsdiff)** — Diff library
- **[anime.js](https://animejs.com/)** — Animation library
- **[Inter](https://rsms.me/inter)**, **[Plus Jakarta Sans](https://www.typewolf.com/plus-jakarta-sans)** & **[JetBrains Mono](https://www.jetbrains.com/lp/mono)** — Typefaces
