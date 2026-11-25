'use strict';

/**
 * RemoteControlService
 *
 * On Linux, Electron's setContentProtection is a no-op, meaning the overlay
 * is always visible in screen shares.  This service replaces the overlay UI
 * entirely: it starts a local HTTP + WebSocket server so any device on the
 * same network can connect via a browser and control OpenCluely remotely.
 *
 * Architecture:
 *   ┌──────────────────────────┐        ┌──────────────────────────┐
 *   │  Linux host (headless)   │        │  Remote device (browser) │
 *   │  ─────────────────────   │        │  ─────────────────────   │
 *   │  captureService          │◄──WS──►│  Control panel web UI    │
 *   │  llmService              │        │  (served by HTTP server) │
 *   │  speechService           │        └──────────────────────────┘
 *   │  sessionManager          │
 *   │  RemoteControlService    │
 *   │    ├─ http.Server        │
 *   │    └─ WebSocketServer    │
 *   └──────────────────────────┘
 */

const http  = require('http');
const os    = require('os');
const path  = require('path');
const crypto = require('crypto');
const ws_pkg = require('ws');
// ws v7 (bundled transitively) exposes the server as `ws.Server`;
// ws v8+ also exports the named `WebSocketServer`. Support both.
const WebSocketServer = ws_pkg.WebSocketServer || ws_pkg.Server;
const { EventEmitter } = require('events');

// ── Inline control panel HTML ─────────────────────────────────────────────────
// Served as a single file; uses Marked + Prism via CDN so no build step is
// needed.  The WebSocket URL is injected at serve-time.
const CONTROL_PANEL_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>OpenCluely · Remote Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" />
<style>
  :root {
    --bg:        #0a0a0f;
    --surface:   #111118;
    --surface2:  #18181f;
    --border:    #2a2a38;
    --accent:    #6c63ff;
    --accent-g:  linear-gradient(135deg, #6c63ff 0%, #a78bfa 100%);
    --text:      #e8e8f0;
    --text-dim:  #888899;
    --green:     #22c55e;
    --red:       #ef4444;
    --yellow:    #eab308;
    --radius:    12px;
    --font:      'Inter', system-ui, sans-serif;
    --mono:      'JetBrains Mono', monospace;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── PIN screen ─────────────────────────────────────────────────────── */
  #pin-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100dvh;
    gap: 24px;
    padding: 32px;
  }
  #pin-screen h1 {
    font-size: 26px;
    font-weight: 700;
    background: var(--accent-g);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  #pin-screen p { color: var(--text-dim); text-align: center; max-width: 320px; }
  #pin-input {
    width: 200px;
    padding: 12px 16px;
    background: var(--surface2);
    border: 1.5px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 22px;
    letter-spacing: 0.2em;
    text-align: center;
    font-family: var(--mono);
    outline: none;
    transition: border-color 0.2s;
  }
  #pin-input:focus { border-color: var(--accent); }
  #pin-error { color: var(--red); font-size: 13px; min-height: 18px; }

  /* ── Main layout ─────────────────────────────────────────────────────── */
  #app { display: none; flex-direction: column; height: 100dvh; }
  #app.visible { display: flex; }

  /* ── Status bar ──────────────────────────────────────────────────────── */
  #status-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .logo {
    font-weight: 700;
    font-size: 15px;
    background: var(--accent-g);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-right: 4px;
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--red);
    transition: background 0.3s;
    flex-shrink: 0;
  }
  .status-dot.connected { background: var(--green); }
  .status-dot.connecting { background: var(--yellow); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .badge {
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .badge.active { border-color: var(--accent); color: var(--accent); }

  #status-label { color: var(--text-dim); font-size: 12px; flex: 1; }

  .btn-icon {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 16px;
    transition: all 0.15s;
    display: flex; align-items: center; gap: 6px;
    font-size: 13px;
  }
  .btn-icon:hover { border-color: var(--accent); color: var(--text); }
  .btn-icon.danger:hover { border-color: var(--red); color: var(--red); }
  .btn-icon.active { border-color: var(--accent); background: rgba(108,99,255,0.12); color: var(--accent); }
  .btn-icon.recording { border-color: var(--red); background: rgba(239,68,68,0.12); color: var(--red); }

  /* ── Content area ────────────────────────────────────────────────────── */
  #content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ── Response panel ──────────────────────────────────────────────────── */
  #response-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    scroll-behavior: smooth;
  }
  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .message {
    display: flex;
    flex-direction: column;
    gap: 6px;
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }

  .message-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .message-role {
    font-weight: 600;
    font-size: 12px;
  }
  .message-role.user { color: var(--accent); }
  .message-role.ai   { color: #a78bfa; }
  .message-role.system { color: var(--text-dim); }

  .message-body {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    line-height: 1.65;
    overflow-x: auto;
  }
  .message-body.user-body {
    background: rgba(108,99,255,0.08);
    border-color: rgba(108,99,255,0.25);
  }
  .message-body.system-body {
    background: transparent;
    border: none;
    padding: 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  /* markdown styles */
  .message-body h1,.message-body h2,.message-body h3 { margin: 12px 0 6px; font-weight: 600; }
  .message-body h1 { font-size: 18px; }
  .message-body h2 { font-size: 15px; }
  .message-body h3 { font-size: 13px; }
  .message-body p  { margin: 6px 0; }
  .message-body ul,.message-body ol { margin: 6px 0; padding-left: 20px; }
  .message-body li { margin: 4px 0; }
  .message-body code:not([class]) {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--surface2);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
    color: #a78bfa;
  }
  .message-body pre {
    margin: 10px 0;
    border-radius: 8px;
    overflow-x: auto;
    position: relative;
  }
  .message-body pre code { font-size: 12px; font-family: var(--mono); }
  .copy-btn {
    position: absolute;
    top: 8px; right: 8px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.15s;
  }
  .copy-btn:hover { background: rgba(255,255,255,0.15); color: var(--text); }

  /* screenshot preview */
  .screenshot-preview {
    max-width: 100%;
    border-radius: 8px;
    border: 1px solid var(--border);
    margin-top: 8px;
    cursor: zoom-in;
    max-height: 300px;
    object-fit: contain;
  }

  /* streaming cursor */
  .streaming-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--accent);
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: blink 0.8s step-end infinite;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

  /* ── Input bar ───────────────────────────────────────────────────────── */
  #input-bar {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    align-items: flex-end;
  }
  #chat-input {
    flex: 1;
    background: var(--surface2);
    border: 1.5px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    resize: none;
    max-height: 140px;
    outline: none;
    transition: border-color 0.2s;
    line-height: 1.5;
  }
  #chat-input:focus { border-color: var(--accent); }
  #chat-input::placeholder { color: var(--text-dim); }

  .send-btn {
    background: var(--accent-g);
    border: none;
    border-radius: 10px;
    padding: 10px 18px;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    flex-shrink: 0;
    align-self: flex-end;
  }
  .send-btn:hover { opacity: 0.88; }
  .send-btn:active { transform: scale(0.96); }
  .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Settings drawer ─────────────────────────────────────────────────── */
  #settings-overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  #settings-overlay.open { display: flex; }
  #settings-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    max-width: 420px;
    max-height: 80dvh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  #settings-panel h2 { font-size: 18px; font-weight: 700; }
  .setting-group { display: flex; flex-direction: column; gap: 6px; }
  .setting-group label { font-size: 12px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .setting-group select,
  .setting-group input[type="text"],
  .setting-group input[type="password"] {
    background: var(--surface2);
    border: 1.5px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;
    width: 100%;
  }
  .setting-group select:focus,
  .setting-group input:focus { border-color: var(--accent); }
  .settings-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .btn-primary {
    background: var(--accent-g);
    border: none;
    border-radius: 8px;
    padding: 9px 20px;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn-primary:hover { opacity: 0.88; }
  .btn-secondary {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 20px;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-secondary:hover { border-color: var(--accent); }

  /* ── Image lightbox ──────────────────────────────────────────────────── */
  #lightbox {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 200;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  #lightbox.open { display: flex; }
  #lightbox img { max-width: 96vw; max-height: 96vh; border-radius: 8px; }

  @media (max-width: 600px) {
    #status-bar { gap: 8px; }
    .logo { font-size: 13px; }
  }
</style>
</head>
<body>

<!-- PIN screen -->
<div id="pin-screen">
  <h1>🔐 OpenCluely</h1>
  <p>Enter the PIN shown in the terminal on the host machine to connect.</p>
  <input id="pin-input" type="password" maxlength="8" placeholder="••••••" autocomplete="off" />
  <div id="pin-error"></div>
</div>

<!-- Main app (hidden until PIN accepted) -->
<div id="app">
  <!-- Status bar -->
  <div id="status-bar">
    <span class="logo">OpenCluely</span>
    <div class="status-dot connecting" id="conn-dot" title="Connection status"></div>
    <span id="status-label">Connecting…</span>
    <span class="badge active" id="skill-badge">DSA</span>
    <span class="badge" id="lang-badge">C++</span>
    <button class="btn-icon" id="screenshot-btn" title="Take screenshot on host (Ctrl+Shift+S)">📸 Screenshot</button>
    <button class="btn-icon" id="mic-btn" title="Toggle voice recognition">🎙 Mic</button>
    <button class="btn-icon danger" id="clear-btn" title="Clear session memory">🗑 Clear</button>
    <button class="btn-icon" id="settings-btn" title="Settings">⚙</button>
  </div>

  <!-- Content -->
  <div id="content">
    <div id="response-panel">
      <div id="messages"></div>
      <div id="input-bar">
        <textarea id="chat-input" placeholder="Ask a question…" rows="1"></textarea>
        <button class="send-btn" id="send-btn">Send</button>
      </div>
    </div>
  </div>
</div>

<!-- Settings drawer -->
<div id="settings-overlay">
  <div id="settings-panel">
    <h2>⚙ Settings</h2>
    <div class="setting-group">
      <label>Gemini API Key</label>
      <input type="password" id="s-gemini-key" placeholder="AIza…" />
    </div>
    <div class="setting-group">
      <label>Coding Language</label>
      <select id="s-language">
        <option value="cpp">C++</option>
        <option value="python">Python</option>
        <option value="java">Java</option>
        <option value="javascript">JavaScript</option>
        <option value="typescript">TypeScript</option>
        <option value="c">C</option>
      </select>
    </div>
    <div class="setting-group">
      <label>Speech Provider</label>
      <select id="s-speech">
        <option value="whisper">Local Whisper</option>
        <option value="azure">Azure Speech</option>
      </select>
    </div>
    <div class="setting-group" id="azure-fields">
      <label>Azure Speech Key</label>
      <input type="password" id="s-azure-key" placeholder="Azure key" />
      <label style="margin-top:8px">Azure Region</label>
      <input type="text" id="s-azure-region" placeholder="e.g. eastus" />
    </div>
    <div class="setting-group">
      <label>Personal Details</label>
      <textarea id="s-personal-details" rows="3" placeholder="Enter background details to tailor replies"></textarea>
    </div>
    <div class="settings-actions">
      <button class="btn-secondary" id="settings-cancel">Cancel</button>
      <button class="btn-primary" id="settings-save">Save</button>
    </div>
  </div>
</div>

<!-- Image lightbox -->
<div id="lightbox"><img id="lightbox-img" alt="Screenshot" /></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
<script>
// ── Config injected by server ──────────────────────────────────────────────
const WS_URL  = '{{WS_URL}}';

// ── State ──────────────────────────────────────────────────────────────────
let ws = null;
let isAuthenticated = false;
let isRecording = false;
let activeSkill = 'dsa';
let activeLanguage = 'cpp';
let streamingEl = null;   // current streaming message body element
let streamingRaw = '';    // accumulated raw markdown for active stream

// ── Utility ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function renderMarkdown(raw) {
  const html = marked.parse(raw || '', { breaks: true });
  return html;
}

function highlightAll(el) {
  el.querySelectorAll('pre code').forEach(block => {
    // add copy button
    const pre = block.parentElement;
    if (!pre.querySelector('.copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy', 1500);
        });
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    }
    Prism.highlightElement(block);
  });
}

function scrollBottom() {
  const msgs = $('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function addMessage({ role, body, isHTML = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'message';

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const roleEl = document.createElement('span');
  roleEl.className = 'message-role ' + role;
  roleEl.textContent = role === 'user' ? 'You' : role === 'ai' ? 'OpenCluely AI' : 'System';
  meta.appendChild(roleEl);

  const time = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString();
  meta.appendChild(time);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'message-body ' + (role === 'user' ? 'user-body' : role === 'system' ? 'system-body' : '');

  if (isHTML) {
    bodyEl.innerHTML = body;
  } else {
    bodyEl.textContent = body;
  }

  wrap.appendChild(meta);
  wrap.appendChild(bodyEl);
  $('messages').appendChild(wrap);
  scrollBottom();
  return bodyEl;
}

function startStreamingMessage(skill) {
  streamingRaw = '';
  streamingEl = addMessage({ role: 'ai', body: '<span class="streaming-cursor"></span>', isHTML: true });
  return streamingEl;
}

function appendStreamingChunk(delta) {
  if (!streamingEl) return;
  streamingRaw += delta;
  streamingEl.innerHTML = renderMarkdown(streamingRaw) + '<span class="streaming-cursor"></span>';
  scrollBottom();
}

function finalizeStreamingMessage(fullResponse) {
  if (!streamingEl) return;
  streamingEl.innerHTML = renderMarkdown(fullResponse || streamingRaw);
  highlightAll(streamingEl);
  streamingEl = null;
  streamingRaw = '';
  scrollBottom();
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  setConnectionState('connecting');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    // send PIN immediately
    send({ type: 'auth', pin: currentPin });
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    setConnectionState('disconnected');
    if (isAuthenticated) {
      addMessage({ role: 'system', body: '⚠ Disconnected from host. Reconnecting in 3 s…' });
    }
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

let currentPin = '';

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'auth-ok':
      isAuthenticated = true;
      setConnectionState('connected');
      $('pin-screen').style.display = 'none';
      $('app').classList.add('visible');
      if (msg.status) applyStatus(msg.status);
      addMessage({ role: 'system', body: '✅ Connected to OpenCluely host.' });
      break;

    case 'auth-fail':
      $('pin-error').textContent = 'Incorrect PIN. Try again.';
      $('pin-input').value = '';
      $('pin-input').focus();
      break;

    case 'status':
      applyStatus(msg);
      break;

    case 'settings':
      applySettingsToUI(msg.settings);
      break;

    case 'llm-response-start':
      startStreamingMessage(msg.skill);
      break;

    case 'llm-response-chunk':
      appendStreamingChunk(msg.delta);
      break;

    case 'llm-response-done':
      finalizeStreamingMessage(msg.response);
      setSendingState(false);
      break;

    case 'llm-error':
      if (streamingEl) { streamingEl.innerHTML = ''; streamingEl = null; }
      addMessage({ role: 'system', body: '❌ LLM error: ' + msg.error });
      setSendingState(false);
      break;

    case 'transcript':
      addMessage({ role: 'user', body: '🎙 ' + msg.text });
      break;

    case 'recording-started':
      isRecording = true;
      $('mic-btn').classList.add('recording');
      $('mic-btn').textContent = '⏹ Stop';
      addMessage({ role: 'system', body: '🎙 Recording started…' });
      break;

    case 'recording-stopped':
      isRecording = false;
      $('mic-btn').classList.remove('recording');
      $('mic-btn').innerHTML = '🎙 Mic';
      addMessage({ role: 'system', body: '⏹ Recording stopped.' });
      break;

    case 'screenshot-captured':
      addMessage({
        role: 'system',
        body: \`Screenshot captured — analyzing…
<img class="screenshot-preview" src="data:\${msg.mimeType};base64,\${msg.imageBase64}" alt="Screenshot" />\`,
        isHTML: true
      });
      // wire lightbox
      const img = $('messages').querySelector('.screenshot-preview:last-of-type');
      if (img) img.onclick = () => openLightbox(img.src);
      break;

    case 'session-cleared':
      $('messages').innerHTML = '';
      addMessage({ role: 'system', body: '🗑 Session cleared.' });
      break;

    case 'speech-status':
      $('mic-btn').title = msg.status;
      $('mic-btn').disabled = !msg.available;
      break;

    case 'skill-changed':
      activeSkill = msg.skill;
      $('skill-badge').textContent = msg.skill.toUpperCase();
      break;

    case 'language-changed':
      activeLanguage = msg.language;
      $('lang-badge').textContent = msg.language.toUpperCase();
      break;
  }
}

function applyStatus(s) {
  if (s.activeSkill) { activeSkill = s.activeSkill; $('skill-badge').textContent = s.activeSkill.toUpperCase(); }
  if (s.language)    { activeLanguage = s.language;  $('lang-badge').textContent = s.language.toUpperCase(); }
}

function applySettingsToUI(s) {
  if (!s) return;
  if (s.geminiKey)       $('s-gemini-key').value = s.geminiKey;
  if (s.codingLanguage)  $('s-language').value = s.codingLanguage;
  if (s.speechProvider)  $('s-speech').value   = s.speechProvider;
  if (s.azureKey)        $('s-azure-key').value  = s.azureKey;
  if (s.azureRegion)     $('s-azure-region').value = s.azureRegion;
  if (s.personalDetails) $('s-personal-details').value = s.personalDetails;
  toggleAzureFields();
}

function setConnectionState(state) {
  const dot = $('conn-dot');
  const label = $('status-label');
  dot.className = 'status-dot ' + state;
  label.textContent = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Disconnected';
}

function setSendingState(sending) {
  $('send-btn').disabled = sending;
  $('chat-input').disabled = sending;
}

// ── PIN screen ──────────────────────────────────────────────────────────────
$('pin-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPin();
});
$('pin-input').addEventListener('input', () => { $('pin-error').textContent = ''; });

function submitPin() {
  currentPin = $('pin-input').value.trim();
  if (!currentPin) return;
  connect();
}

// Auto-submit when 6 digits typed
$('pin-input').addEventListener('input', () => {
  if ($('pin-input').value.length >= 6) submitPin();
});

// ── Chat ────────────────────────────────────────────────────────────────────
$('send-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('chat-input').addEventListener('input', () => {
  $('chat-input').style.height = 'auto';
  $('chat-input').style.height = Math.min($('chat-input').scrollHeight, 140) + 'px';
});

function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text || !isAuthenticated) return;
  addMessage({ role: 'user', body: text });
  $('chat-input').value = '';
  $('chat-input').style.height = 'auto';
  setSendingState(true);
  send({ type: 'send-message', text });
}

// ── Toolbar actions ─────────────────────────────────────────────────────────
$('screenshot-btn').addEventListener('click', () => {
  if (!isAuthenticated) return;
  addMessage({ role: 'system', body: '📸 Triggering screenshot on host…' });
  setSendingState(true);
  send({ type: 'take-screenshot' });
});

$('mic-btn').addEventListener('click', () => {
  if (!isAuthenticated) return;
  send({ type: 'toggle-speech' });
});

$('clear-btn').addEventListener('click', () => {
  if (!isAuthenticated || !confirm('Clear session memory?')) return;
  send({ type: 'clear-session' });
});

// ── Settings ────────────────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', () => {
  $('settings-overlay').classList.add('open');
  send({ type: 'get-settings' });
});
$('settings-cancel').addEventListener('click', () => $('settings-overlay').classList.remove('open'));
$('settings-overlay').addEventListener('click', e => {
  if (e.target === $('settings-overlay')) $('settings-overlay').classList.remove('open');
});
$('settings-save').addEventListener('click', () => {
  send({
    type: 'save-settings',
    settings: {
      geminiKey:      $('s-gemini-key').value,
      codingLanguage: $('s-language').value,
      speechProvider: $('s-speech').value,
      azureKey:       $('s-azure-key').value,
      azureRegion:    $('s-azure-region').value,
      personalDetails: $('s-personal-details').value,
    }
  });
  $('settings-overlay').classList.remove('open');
  addMessage({ role: 'system', body: '✅ Settings saved.' });
});

function toggleAzureFields() {
  $('azure-fields').style.display = $('s-speech').value === 'azure' ? 'flex' : 'none';
  $('azure-fields').style.flexDirection = 'column';
  $('azure-fields').style.gap = '6px';
}
$('s-speech').addEventListener('change', toggleAzureFields);
toggleAzureFields();

// ── Lightbox ────────────────────────────────────────────────────────────────
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.add('open');
}
$('lightbox').addEventListener('click', () => $('lightbox').classList.remove('open'));

// ── Focus PIN input on load ─────────────────────────────────────────────────
window.addEventListener('load', () => $('pin-input').focus());
</script>
</body>
</html>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getLocalIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

// ── RemoteControlService ──────────────────────────────────────────────────────

class RemoteControlService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.appController   - ApplicationController instance
   * @param {object} opts.captureService  - CaptureService singleton
   * @param {object} opts.llmService      - LLMService singleton
   * @param {object} opts.speechService   - SpeechService singleton
   * @param {object} opts.sessionManager  - SessionManager singleton
   * @param {object} opts.logger          - Winston logger
   */
  constructor(opts = {}) {
    super();
    this.app            = opts.appController;
    this.captureService = opts.captureService;
    this.llmService     = opts.llmService;
    this.speechService  = opts.speechService;
    this.sessionManager = opts.sessionManager;
    this.logger         = opts.logger || console;

    this.port   = parseInt(process.env.REMOTE_CONTROL_PORT || '3099', 10);
    this.pin    = process.env.REMOTE_CONTROL_PIN || generatePin();
    this.server = null;
    this.wss    = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set(); // authenticated clients only
    /** @type {Set<import('ws').WebSocket>} */
    this.pendingClients = new Set(); // waiting for PIN
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    this.server = http.createServer((req, res) => this._handleHTTP(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._handleConnection(ws));

    await new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this._printStartBanner();
    this._wireSpeechEvents();
  }

  stop() {
    this.wss?.close();
    this.server?.close();
    this.clients.clear();
    this.pendingClients.clear();
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  _handleHTTP(req, res) {
    if (req.method !== 'GET' || req.url !== '/') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ips  = getLocalIPs();
    const wsUrl = `ws://${ips[0]}:${this.port}`;
    const html  = CONTROL_PANEL_HTML.replace('{{WS_URL}}', wsUrl);

    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  _handleConnection(ws) {
    this.pendingClients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (this.pendingClients.has(ws)) {
        // Only accept auth messages from unauthenticated sockets
        if (msg.type === 'auth') {
          this._handleAuth(ws, msg.pin);
        }
        return;
      }

      // Authenticated path
      this._handleClientMessage(ws, msg).catch((err) => {
        this.logger.error('RemoteControlService: error handling client message', {
          error: err.message,
          type: msg.type,
        });
      });
    });

    ws.on('close', () => {
      this.pendingClients.delete(ws);
      this.clients.delete(ws);
      this.logger.info('RemoteControlService: client disconnected', {
        remaining: this.clients.size,
      });
    });

    ws.on('error', (err) => {
      this.logger.warn('RemoteControlService: WebSocket error', { error: err.message });
    });
  }

  _handleAuth(ws, pin) {
    if (String(pin).trim() !== String(this.pin).trim()) {
      this._send(ws, { type: 'auth-fail' });
      return;
    }

    this.pendingClients.delete(ws);
    this.clients.add(ws);
    this.logger.info('RemoteControlService: client authenticated', {
      total: this.clients.size,
    });

    // Send welcome + current state
    const status = this._buildStatus();
    this._send(ws, { type: 'auth-ok', status });
  }

  async _handleClientMessage(ws, msg) {
    switch (msg.type) {
      case 'send-message':
        await this._handleSendMessage(msg.text);
        break;

      case 'take-screenshot':
        await this._handleScreenshot();
        break;

      case 'toggle-speech':
        this._handleToggleSpeech();
        break;

      case 'clear-session':
        this._handleClearSession();
        break;

      case 'update-skill':
        if (msg.skill) {
          this.app.activeSkill = msg.skill;
          this.sessionManager.setActiveSkill(msg.skill);
          this.broadcast({ type: 'skill-changed', skill: msg.skill });
        }
        break;

      case 'update-language':
        if (msg.language) {
          this.app.codingLanguage = msg.language;
          this.broadcast({ type: 'language-changed', language: msg.language });
        }
        break;

      case 'get-settings':
        this._send(ws, { type: 'settings', settings: this.app.getSettings() });
        break;

      case 'save-settings':
        if (msg.settings && typeof msg.settings === 'object') {
          this.app.saveSettings(msg.settings);
          this.broadcast({ type: 'language-changed', language: this.app.codingLanguage });
        }
        break;

      default:
        this.logger.debug('RemoteControlService: unknown message type', { type: msg.type });
    }
  }

  // ── Action handlers ─────────────────────────────────────────────────────────

  async _handleSendMessage(text) {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    const clean = text.trim().substring(0, 10000);
    this.sessionManager.addUserInput(clean, 'chat');

    const sessionHistory = this.sessionManager.getOptimizedHistory();
    await this.app.processWithLLM(clean, sessionHistory);
  }

  async _handleScreenshot() {
    try {
      const capture = await this.captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        this.broadcast({ type: 'llm-error', error: 'Screenshot capture failed' });
        return;
      }

      // Forward the raw screenshot to all clients
      const imageBase64 = capture.imageBuffer.toString('base64');
      this.broadcast({
        type:        'screenshot-captured',
        imageBase64,
        mimeType:    capture.mimeType || 'image/png',
      });

      // Then analyze with LLM
      const sessionHistory = this.sessionManager.getOptimizedHistory();
      const needsLang = ['dsa'].includes(this.app.activeSkill);

      const seq = (this.app._responseSeq = (this.app._responseSeq || 0) + 1);
      const messageId = `rc-img-${Date.now()}-${seq}`;

      this.broadcast({ type: 'llm-response-start', messageId, skill: this.app.activeSkill });

      const llmResult = await this.llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.app.activeSkill,
        sessionHistory.recent,
        needsLang ? this.app.codingLanguage : null,
        (delta) => {
          this.broadcast({ type: 'llm-response-chunk', messageId, delta });
        }
      );

      llmResult.metadata = { ...llmResult.metadata, messageId };

      this.sessionManager.addModelResponse(llmResult.response, {
        skill: this.app.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        isImageAnalysis: true,
      });

      this.broadcast({
        type:     'llm-response-done',
        messageId,
        response: llmResult.response,
        metadata: llmResult.metadata,
      });
    } catch (err) {
      this.logger.error('RemoteControlService: screenshot/LLM failed', { error: err.message });
      this.broadcast({ type: 'llm-error', error: err.message });
    }
  }

  _handleToggleSpeech() {
    if (!this.speechService.isAvailable || !this.speechService.isAvailable()) {
      this.broadcast({
        type:      'speech-status',
        status:    'Speech recognition is not configured',
        available: false,
      });
      return;
    }
    const status = this.speechService.getStatus();
    if (status.isRecording) {
      this.speechService.stopRecording();
    } else {
      this.speechService.startRecording();
    }
  }

  _handleClearSession() {
    this.sessionManager.clear();
    this.broadcast({ type: 'session-cleared' });
    this.logger.info('RemoteControlService: session cleared by remote client');
  }

  // ── processWithLLM integration ──────────────────────────────────────────────
  // Called by ApplicationController.processWithLLM() on Linux so streaming
  // chunks and the final response are forwarded to remote clients.

  /**
   * Notify all remote clients that an LLM streaming response is starting.
   */
  onLLMResponseStart(messageId, skill) {
    this.broadcast({ type: 'llm-response-start', messageId, skill });
  }

  /**
   * Forward a streaming chunk to all remote clients.
   */
  onLLMResponseChunk(messageId, delta) {
    this.broadcast({ type: 'llm-response-chunk', messageId, delta });
  }

  /**
   * Notify all remote clients that an LLM response is complete.
   */
  onLLMResponseDone(messageId, response, metadata) {
    this.broadcast({ type: 'llm-response-done', messageId, response, metadata });
  }

  /**
   * Forward an LLM error to all remote clients.
   */
  onLLMError(errorMessage) {
    this.broadcast({ type: 'llm-error', error: errorMessage });
  }

  // ── Speech event wiring ─────────────────────────────────────────────────────

  _wireSpeechEvents() {
    this.speechService.on('recording-started', () => {
      this.broadcast({ type: 'recording-started' });
    });

    this.speechService.on('recording-stopped', () => {
      this.broadcast({ type: 'recording-stopped' });
    });

    this.speechService.on('transcription', (text) => {
      this.broadcast({ type: 'transcript', text });
    });

    this.speechService.on('status', (status) => {
      const available = this.speechService.isAvailable
        ? this.speechService.isAvailable()
        : false;
      this.broadcast({ type: 'speech-status', status, available });
    });

    this.speechService.on('error', (error) => {
      const available = this.speechService.isAvailable
        ? this.speechService.isAvailable()
        : false;
      this.broadcast({ type: 'speech-status', status: String(error), available });
    });
  }

  // ── Broadcast helpers ───────────────────────────────────────────────────────

  /**
   * Send a message to all authenticated clients.
   */
  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const client of this.clients) {
      this._sendRaw(client, payload);
    }
  }

  _send(ws, obj) {
    this._sendRaw(ws, JSON.stringify(obj));
  }

  _sendRaw(ws, payload) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    } catch (err) {
      this.logger.warn('RemoteControlService: failed to send to client', { error: err.message });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _buildStatus() {
    return {
      activeSkill: this.app.activeSkill || 'dsa',
      language:    this.app.codingLanguage || 'cpp',
      llmReady:    this.llmService.isInitialized || false,
      speechAvail: this.speechService.isAvailable ? this.speechService.isAvailable() : false,
    };
  }

  _printStartBanner() {
    const ips   = getLocalIPs();
    const divider = '─'.repeat(56);
    const lines = [
      '',
      divider,
      '  OpenCluely — Linux Headless Remote Control Mode',
      divider,
      `  PIN : ${this.pin}   (shown once — keep this private)`,
      '',
      '  Open one of these URLs on another device:',
      ...ips.map(ip => `    http://${ip}:${this.port}`),
      divider,
      '',
    ];
    lines.forEach(l => process.stdout.write(l + '\n'));
    this.logger.info('RemoteControlService started', {
      port: this.port,
      ips,
      pinSet: true,
    });
  }
}

module.exports = RemoteControlService;
