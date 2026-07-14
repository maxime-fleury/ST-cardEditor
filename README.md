# 🧙 ST Card Editor — SillyTavern Character Card Studio

A web-based tool for editing, translating, and enhancing **SillyTavern character cards** with AI assistance. Drag & drop your cards, edit every field, and let AI help you refine personalities, translate content, or generate richer descriptions.

![Version](https://img.shields.io/badge/version-1.0.0-purple)
![Runtime](https://img.shields.io/badge/runtime-Bun-000?logo=bun)
![License](https://img.shields.io/badge/license-MIT-blue)
[![Live Demo](https://img.shields.io/badge/demo-gh--pages-9147ff?logo=githubpages)](https://maxime-fleury.github.io/ST-cardEditor/)
[![Deploy](https://github.com/maxime-fleury/ST-cardEditor/actions/workflows/deploy.yml/badge.svg)](https://github.com/maxime-fleury/ST-cardEditor/actions/workflows/deploy.yml)

---

## ✨ Features

### 🃏 Card Library
- **Drag & drop** loading of `.png`, `.json`, and `.webp` SillyTavern character cards
- Automatic parsing of embedded card data from PNG/WebP files (supports both `chara` and `ccv3` chunks)
- Visual card library with avatars, names, creators, and tags
- Stable card identification via content hashing

### ✏️ Full Card Editor
Four tabbed panels covering every aspect of the **V2/V3 card spec**:

| Tab | Fields |
|-----|--------|
| **Core** | Name, Description, First Message, Scenario, Creator, Version, Tags |
| **Personality** | Personality Summary, Example Messages |
| **Advanced** | System Prompt, Post-History Instructions, Creator Notes, Alternate Greetings |
| **Lorebook** | Full character lorebook entry management |

### 🤖 AI Assistant (OpenRouter)
- Connect via **OpenRouter API key** for access to 200+ models
- **Smart editing** — ask the AI to edit specific fields or the entire card
- **Quick actions** — one-click Translate, Enhance, Expand Personality, Improve First Message
- Real-time credit tracking and model pricing display
- Chat history persisted across sessions
- Auto-select target field: Description, Personality, First Message, Scenario, Example Messages, System Prompt, or Full Card

### 💾 Storage & Export
- **Auto-save** to browser localStorage with debounced writes
- **Export as JSON** — clean, formatted card data
- **Export as PNG** — embeds card data into a valid PNG (SillyTavern-compatible)
- Auto-generated fallback avatar PNG for cards without images
- Storage usage monitor

### 🎨 Design
- **Dark purple theme** inspired by Twitch
- Custom scrollbars, smooth transitions, and micro-interactions
- Toast notifications for all actions
- Keyboard shortcuts (`Ctrl+S` save, `Ctrl+N` new card)
- Fully responsive layout (adapts to tablet and mobile)

---

## 🚀 Getting Started

### Prerequisites

- **[Bun](https://bun.sh)** runtime (v1.0+)

### Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone the repository
git clone <your-repo-url>
cd st-card-editor

# Start the dev server (with file watching)
bun run dev

# Or start in production mode
bun run start
```

The app will be available at **http://localhost:8182**.

Or try it instantly on **GitHub Pages**:

[**https://maxime-fleury.github.io/ST-cardEditor/**](https://maxime-fleury.github.io/ST-cardEditor/)

### Getting an API Key (for AI features)

1. Go to [OpenRouter.ai/keys](https://openrouter.ai/keys)
2. Create an account and generate an API key
3. Paste the key into the **Settings** modal (gear icon in the top-right)
4. Click **Refresh Models** to load available AI models
5. Select your preferred model from the navbar dropdown

---

## 🎮 Usage

### Loading Cards
- **Drag & drop** any `.png`, `.json`, or `.webp` file onto the left panel's drop zone
- Click **Browse files** to select cards via the file picker
- Multiple cards can be loaded at once

### Editing
1. Click a card in the library to select it
2. Edit any field across the four tabs
3. Changes auto-save (debounced) — or click **Save** manually
4. Use **JSON / PNG** export buttons to download the finished card

### AI Editing
1. Select a target field from the dropdown below the chat input
2. Type a prompt (e.g., "Make this more mysterious and aloof")
3. Press **Enter** or click the send button
4. The AI responds and automatically applies changes to the selected field

### Quick Actions
Click any suggestion chip to instantly:
- 🌐 **Translate to French** (translates entire card)
- ⭐ **Enhance Description** (adds sensory details)
- 🧠 **Expand Personality** (adds quirks and motivations)
- 💬 **Improve First Message** (makes it more engaging)

---

## 🧰 Project Structure

```
st-card-editor/
├── public/
│   ├── index.html      # Main HTML with full UI layout
│   └── style.css       # Dark purple theme stylesheet
├── js/
│   ├── cardEngine.js   # Card parsing, normalization, PNG chunk embedding
│   ├── aiService.js    # OpenRouter API client (models, chat, credits)
│   ├── storage.js      # localStorage persistence layer
│   └── ui.js           # Main UI controller and event bindings
├── server.js           # Bun static file server (port 8182)
├── package.json        # Project metadata and scripts
└── README.md           # This file
```

### Architecture

The app is a **single-page application** built with vanilla JavaScript and **Bootstrap 5.3** for layout:

- **`cardEngine.js`** — Parses SillyTavern card formats (V1 flat, V2/V3 spec), extracts embedded data from PNG/WebP files (`chara`/`ccv3` tEXt chunks), and handles stable ID generation via content hashing.
- **`aiService.js`** — Wraps the OpenRouter REST API: lists models with pricing, sends chat completions with system prompts tailored to the target field, and fetches account credit/usage info.
- **`storage.js`** — Thin wrapper around `localStorage` with namespaced keys (`stce_*`), JSON serialization, quota error handling, and chat history trimming.
- **`ui.js`** — Glues everything together: renders the card list, populates the editor, manages the AI chat interface, orchestrates PNG export with chunk embedding, and handles all user interactions.

---

## 🧪 Technical Details

### PNG Card Embedding

The app follows the SillyTavern convention of embedding card JSON inside the `tEXt` chunk of a PNG file with the keyword `chara` (or legacy `ccv3`). The `ui.js` module re-encodes PNGs with the embedded chunk placed right before the `IEND` chunk:

```
PNG Signature → IHDR → ... → IDAT → tEXt (chara=JSON) → IEND
```

### Supported Card Specs

- **V1 (flat)** — `{ name, description, personality, ... }` without `spec` field
- **V2/V3** — `{ spec: "chara_card_v2", spec_version: "2.0", data: { ... } }`

### Model Selection

Models are fetched from OpenRouter and sorted with free models first, then by ascending price. The navbar selector and per-chat override selector give you fine-grained control.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save current card |
| `Ctrl+N` / `Cmd+N` | Create new blank card |
| `Enter` (in AI input) | Send message to AI |
| `Shift+Enter` (in AI input) | New line |

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests for:

- Additional card spec support
- More AI quick actions / presets
- Batch editing features
- Theme customization
- Localization

---

## ⚡ CI/CD

Every push to the `main` branch automatically deploys the latest version to GitHub Pages via [GitHub Actions](.github/workflows/deploy.yml).

Check the [Actions tab](https://github.com/maxime-fleury/ST-cardEditor/actions) for deployment status.

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

## 🙏 Acknowledgments

- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — The amazing AI roleplay frontend these cards are made for
- **[OpenRouter](https://openrouter.ai)** — Multi-model API with generous free tier
- **[Bootstrap](https://getbootstrap.com)** — UI framework
- **[Bootstrap Icons](https://icons.getbootstrap.com)** — Icon set
- **[Inter](https://rsms.me/inter)** & **[JetBrains Mono](https://www.jetbrains.com/lp/mono)** — Typefaces
