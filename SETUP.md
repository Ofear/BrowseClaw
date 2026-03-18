# BrowseClaw — Setup Guide

This guide covers everything a new user needs to get BrowseClaw working from scratch.

---

## What You Need

| Requirement | Details |
|---|---|
| **Google Chrome** (or Chromium-based browser) | Any recent version |
| **Node.js** v18 or later | [nodejs.org](https://nodejs.org) |
| **OpenClaw** (the AI gateway) | Installed via npm (see below) |
| **An AI provider account** | Anthropic, OpenAI, xAI (Grok), Gemini, or others |

---

## Step 1 — Install OpenClaw

OpenClaw is the local AI gateway that BrowseClaw connects to. Install it globally via npm:

```bash
npm install -g openclaw
```

Verify the installation:

```bash
openclaw --version
```

---

## Step 2 — Run the Setup Wizard

OpenClaw's interactive wizard configures your AI provider, auth token, and gateway settings:

```bash
openclaw onboard
```

The wizard will ask you to:
1. **Choose an AI provider** — Anthropic (Claude), OpenAI, xAI (Grok), Google Gemini, Ollama (local), or many others
2. **Enter your API key** for that provider
3. **Set a gateway auth token** — a secret string BrowseClaw will use to connect (or let the wizard generate one)
4. **Choose a gateway bind mode** — keep `loopback` (local-only, recommended)

When it's done, your config is saved to `~/.openclaw/openclaw.json`.

---

## Step 3 — Start the Gateway

Start the OpenClaw gateway (keep this running while using BrowseClaw):

```bash
openclaw gateway start
```

By default it listens on `ws://127.0.0.1:18790`.

To start it automatically on login, the wizard can install it as a background service — choose that option when prompted, or run:

```bash
openclaw gateway install
```

---

## Step 4 — Find Your Auth Token

BrowseClaw needs your gateway auth token to connect. Find it in your config:

```bash
openclaw config get gateway.auth.token
```

Or open the file directly:

```
~/.openclaw/openclaw.json
```

Look for:
```json
"gateway": {
  "auth": {
    "token": "your-token-here"
  }
}
```

Keep this token — you'll paste it into BrowseClaw's settings.

---

## Step 5 — Load the BrowseClaw Extension

1. Clone or download this repository:
   ```bash
   git clone https://github.com/Ofear/BrowseClaw.git
   ```

2. Open Chrome and go to: `chrome://extensions`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked**

5. Select the `BrowseClaw` folder you just cloned

The 🦞 BrowseClaw icon will appear in your Chrome toolbar.

---

## Step 6 — Configure BrowseClaw

1. Click the 🦞 icon in Chrome's toolbar to open the side panel
2. Click the **⚙ Settings** button (gear icon, top-right of the panel)
3. Fill in:
   - **Gateway URL**: `ws://127.0.0.1:18790` (default — leave as-is unless you changed the port)
   - **API Token**: paste the token from Step 4
4. Click **Test Connection** — you should see a green "Connected" message
5. Optionally click **Fetch Models** to load available models from your gateway
6. Click **Save Settings**

---

## You're Ready

Open any webpage in Chrome, click the 🦞 icon to open the side panel, and start chatting.

Try the quick-action buttons at the top (**Summarize**, **Extract Data**, **Scan Forms**) or just type a question about the page.

---

## Troubleshooting

**"Could not connect to gateway"**
- Make sure `openclaw gateway start` is running
- Check that the Gateway URL in settings matches the port in `~/.openclaw/openclaw.json` → `gateway.port`
- On Windows, check that nothing is blocking port 18790 (firewall, antivirus)

**"Unauthorized" or 403 error**
- Double-check the API token — copy it exactly from `openclaw config get gateway.auth.token`
- No spaces or extra characters

**Side panel doesn't open**
- Click the 🦞 icon in the toolbar; if nothing opens, right-click and choose "Open side panel"
- Make sure you loaded the extension as **unpacked** with Developer mode ON

**Model returns no response**
- Go to Settings → click **Fetch Models** to confirm the gateway is returning models
- Try the default `openclaw` model identifier
- Check the OpenClaw gateway logs: `openclaw gateway logs`

---

## Optional: Set a Default Model

After running `openclaw onboard`, your default model is set globally. To change it:

```bash
openclaw config set agents.defaults.model.primary "anthropic/claude-opus-4-5"
```

Or pick any model identifier shown in BrowseClaw's Settings → Fetch Models dropdown.

---

## Context Window Tips

BrowseClaw shows a **context meter** in the bottom-left of the input bar (e.g. `8 msgs · 4% of 200k`). When it turns amber or red:

- Click the **Sessions** button (`≡`) to start a new session
- Or click the **New Session** button (`+`) in the header

This keeps responses sharp and prevents the model from losing track of earlier context.
