# 🦞 BrowseClaw

**BrowseClaw** is a Chrome extension that lets you chat with and control any webpage using an AI assistant powered by [OpenClaw](https://github.com/Ofear/openclaw) — a local AI gateway. Ask it to summarize pages, extract data, fill forms, click buttons, draw on canvases, and much more — all from a side panel without leaving your browser.

---

## Features

### 💬 Chat Interface
- Persistent side panel with streaming AI responses
- Markdown rendering: bold, italic, headers, lists, blockquotes, code blocks, links
- Collapsible action blocks — agent actions are collapsed into a readable summary (e.g. `drag (170,250 → 170,150)`) and can be expanded to view the full JSON
- Message editing: click **Edit** on any user message to revise it — removes subsequent messages (with confirmation) and re-sends from that point

### 📄 Page Context
- Automatically injects the current page's text content, title, and URL into every message
- Includes the **currently focused element** (tag, selector, aria-label, contenteditable state) so the agent types into the right input without navigating away
- Configurable max context length (default 12,000 characters)
- Toggle page context on/off per message

### 👁️ Vision Mode
- Attach a screenshot of the current page with each message
- The AI can visually see exactly what you see, enabling layout-aware interactions
- **Auto session rotation** — server session key rotates every 5 vision messages so accumulated screenshots don't bloat the model's context
- **Vision reminder** — after 3 consecutive vision messages, a banner appears prompting you to turn vision off and save context

### ⚡ Page Actions
The AI can interact with any element on your page using structured action commands:

| Action | Description |
|---|---|
| `click` | Click an element by CSS selector |
| `click_text` | Click by visible text content |
| `double_click` | Double-click an element |
| `right_click` | Right-click (opens context menu) |
| `hover` | Hover to trigger tooltips/dropdowns |
| `fill` | Fill and clear an input/textarea (works with contenteditable) |
| `type` | Type into rich text editors (WhatsApp, Slack, etc.) |
| `press_key` | Press Enter, Tab, Escape, arrow keys, etc. |
| `select` | Choose a dropdown option |
| `scroll` | Scroll the page (up/down/top/bottom) |
| `check` | Check or uncheck a checkbox |
| `submit` | Submit a form |
| `highlight` | Visually highlight elements |
| `get_rect` | Get element bounding rect (for computing drag coordinates) |
| `drag` | Drag from one point to another — supports canvas drawing apps |

Actions execute in sequence and results are shown as compact pills in the chat.

### 🎨 Visual Debug Mode
When debug mode is enabled, every action is visualized on the page in real time:
- **Ghost cursor** — a crosshair tracks the action target coordinates
- **Element highlight** — a pulsing orange border highlights the target element before clicking
- **Click ripple** — animated ripple effect on click/double-click
- **Drag path** — SVG line drawn from drag start to end, with coordinate labels
- **Action label** — floating badge shows the action name and selector
- **Configurable step delay** — slow down execution (300ms–1200ms) to follow along
- **Step-by-step mode** — pause before each action and advance manually with a "Step →" button

### 📁 Session Management
- Multiple named sessions persisted in `chrome.storage.local`
- Sessions auto-named from the first user message
- Session picker panel — switch between past sessions or start a new one
- Clear chat rotates the server session key for a clean AI context

### ⚙️ Settings
- **Gateway URL** — configurable OpenClaw WebSocket address (default `ws://127.0.0.1:18790`)
- **API Token** — OpenClaw authentication token (show/hide toggle)
- **Model** — fetch available models from gateway or enter a custom identifier
- **Theme** — Dark, Light, or System
- **Device Identity** — load Ed25519 signing key from `~/.openclaw/identity/` for authenticated connections
- **Test Connection** — verify gateway connectivity before sending messages

### 🚀 Quick Actions Bar
One-click prompts for common tasks:
- **Summarize** — concise page summary
- **Extract Data** — structured data extraction
- **Scan Forms** — list all forms and interactive elements
- **Actions** — list what you can do on this page
- **Describe (Vision)** — take a screenshot and describe what the AI sees

---

## Architecture

BrowseClaw is a **Manifest V3** Chrome extension with four components:

| File | Role |
|---|---|
| `manifest.json` | Extension config, permissions, service worker |
| `background.js` | Service worker — side panel setup, content script injection, screenshot capture |
| `content.js` | Content script — runs in page context, executes all DOM actions and debug overlays |
| `sidepanel.html/js/css` | Main UI — chat interface, settings, session management, WebSocket client |
| `settings.html/js` | Standalone settings page (optional, via extension options) |

### OpenClaw WebSocket Protocol
BrowseClaw communicates with the OpenClaw gateway over WebSocket using a custom JSON-RPC protocol:
- **Connect** — handshake with token auth and client metadata
- **`chat.send`** — send a message to a session, receive streaming `chat` events
- **`models.list`** — fetch available models
- **`chat.abort`** — stop generation mid-stream
- **`health`** — connectivity check

---

## Requirements

- Google Chrome (or any Chromium-based browser)
- [OpenClaw](https://github.com/Ofear/openclaw) gateway running locally (default: `ws://127.0.0.1:18790`)

---

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Open the BrowseClaw side panel from the toolbar icon
6. Go to **Settings**, enter your OpenClaw gateway URL and API token, and click **Save Settings**

---

## Generating Icons

If you need to regenerate the extension icons:

```bash
node generate-icons.js
```

Requires Node.js with the `canvas` package installed.

---

## License

MIT
