/* AI Voice Assistant - frontend logic
 * Sections: 1) state  2) helpers  3) markdown  4) rendering  5) chat actions
 *           6) backend call  7) text-to-speech  8) speech-to-text  9) events
 */
"use strict";

// ---------------------------------------------------------------------------
// 1) State
// ---------------------------------------------------------------------------
const STORAGE_KEY = "ai-voice-assistant-chats";
const ACTIVE_KEY = "ai-voice-assistant-active-chat";
const DEFAULT_TITLE = "New chat";

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"), overlay: $("overlay"), menuBtn: $("menuBtn"),
  newChatBtn: $("newChatBtn"), chatList: $("chatList"), chatTitle: $("chatTitle"),
  messages: $("messages"), input: $("messageInput"), sendBtn: $("sendBtn"),
  micBtn: $("micBtn"), listening: $("listening"), stopSpeakBtn: $("stopSpeakBtn"),
  clearBtn: $("clearBtn"), autoSpeak: $("autoSpeak"), toast: $("toast"), banner: $("statusBanner"),
};

let chats = loadChats();            // [{ id, title, messages: [{role, content, time, isError?}] }]
let activeChatId = localStorage.getItem(ACTIVE_KEY);
let isLoading = false;

// ---------------------------------------------------------------------------
// 2) Helpers
// ---------------------------------------------------------------------------
function loadChats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    localStorage.setItem(ACTIVE_KEY, activeChatId || "");
  } catch (error) {
    showToast("Could not save chat history (browser storage is full or blocked).");
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getActiveChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

// ---------------------------------------------------------------------------
// 3) Safe Markdown (everything is HTML-escaped FIRST, so no script injection)
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatInline(escapedText) {
  return escapedText
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(text) {
  // Pull out ``` code blocks first and replace them with placeholders.
  const codeBlocks = [];
  const withPlaceholders = text.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return "\n\u0000CODE" + (codeBlocks.length - 1) + "\u0000\n";
  });

  const lines = escapeHtml(withPlaceholders).split("\n");
  let html = "";
  let openList = null;       // "ul" | "ol" | null
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) { html += "<p>" + formatInline(paragraph.join("<br>")) + "</p>"; paragraph = []; }
  };
  const closeList = () => {
    if (openList) { html += "</" + openList + ">"; openList = null; }
  };
  const openListType = (type) => {
    if (openList !== type) { closeList(); html += "<" + type + ">"; openList = type; }
  };

  for (const line of lines) {
    let match;
    if ((match = line.match(/^\u0000CODE(\d+)\u0000$/))) {
      flushParagraph(); closeList();
      html += "<pre><code>" + escapeHtml(codeBlocks[Number(match[1])]) + "</code></pre>";
    } else if ((match = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushParagraph(); openListType("ul");
      html += "<li>" + formatInline(match[1]) + "</li>";
    } else if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph(); openListType("ol");
      html += "<li>" + formatInline(match[1]) + "</li>";
    } else if ((match = line.match(/^#{1,6}\s+(.*)$/))) {
      flushParagraph(); closeList();
      html += "<h4>" + formatInline(match[1]) + "</h4>";
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList(); paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return html;
}

// ---------------------------------------------------------------------------
// 4) Rendering
// ---------------------------------------------------------------------------
function renderSidebar() {
  els.chatList.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-history";
    empty.textContent = "No chats yet";
    els.chatList.appendChild(empty);
    return;
  }
  [...chats].reverse().forEach((chat) => {
    const item = document.createElement("li");
    item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");

    const openBtn = document.createElement("button");
    openBtn.className = "chat-open";
    openBtn.type = "button";
    openBtn.textContent = chat.title;          // textContent = safe
    openBtn.dataset.id = chat.id;
    openBtn.dataset.action = "open";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-delete";
    deleteBtn.type = "button";
    deleteBtn.textContent = "🗑";
    deleteBtn.setAttribute("aria-label", "Delete chat: " + chat.title);
    deleteBtn.dataset.id = chat.id;
    deleteBtn.dataset.action = "delete";

    item.append(openBtn, deleteBtn);
    els.chatList.appendChild(item);
  });
}

function buildMessageElement(message, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "message " + message.role + (message.isError ? " error" : "");

  if (message.role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    avatar.setAttribute("aria-hidden", "true");
    wrapper.appendChild(avatar);
  }

  const column = document.createElement("div");
  column.className = "bubble-col";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (message.role === "assistant" && !message.isError) {
    bubble.innerHTML = renderMarkdown(message.content);   // safe: escaped first
  } else {
    bubble.textContent = message.content;
  }
  column.appendChild(bubble);

  const meta = document.createElement("div");
  meta.className = "meta";
  const time = document.createElement("span");
  time.textContent = formatTime(message.time);
  meta.appendChild(time);

  if (message.role === "assistant" && !message.isError) {
    meta.appendChild(makeActionButton("🔊", "Read aloud", "speak", index));
    meta.appendChild(makeActionButton("⏹", "Stop speaking", "stop", index));
    meta.appendChild(makeActionButton("📋 Copy", "Copy response", "copy", index));
  }
  column.appendChild(meta);
  wrapper.appendChild(column);
  return wrapper;
}

function makeActionButton(label, ariaLabel, action, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-btn";
  button.textContent = label;
  button.title = ariaLabel;
  button.setAttribute("aria-label", ariaLabel);
  button.dataset.action = action;
  button.dataset.index = String(index);
  return button;
}

function renderWelcome() {
  els.messages.innerHTML = `
    <div class="welcome">
      <div class="logo" aria-hidden="true">🎙</div>
      <h2>How can I help you today?</h2>
      <p>Type a question or press the microphone and speak.</p>
      <div class="suggestions">
        <button class="suggestion" type="button">Explain inheritance in Java in simple words</button>
        <button class="suggestion" type="button">What is object oriented programming?</button>
        <button class="suggestion" type="button">Give me tips for a placement interview</button>
      </div>
    </div>`;
}

function renderMessages() {
  const chat = getActiveChat();
  els.chatTitle.textContent = chat ? chat.title : DEFAULT_TITLE;
  els.messages.innerHTML = "";

  if (!chat || chat.messages.length === 0) {
    if (!isLoading) { renderWelcome(); return; }
  }
  if (chat) {
    chat.messages.forEach((message, index) => els.messages.appendChild(buildMessageElement(message, index)));
  }
  if (isLoading) {
    const typing = document.createElement("div");
    typing.className = "message assistant";
    typing.innerHTML = '<div class="avatar" aria-hidden="true">🤖</div><div class="bubble-col"><div class="bubble typing">' +
      '<span class="dots"><span></span><span></span><span></span></span> AI is thinking...</div></div>';
    els.messages.appendChild(typing);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setLoading(loading) {
  isLoading = loading;
  els.sendBtn.disabled = loading;
  els.input.disabled = loading;
  els.micBtn.disabled = loading;
  renderMessages();
  if (!loading) els.input.focus();
}

// ---------------------------------------------------------------------------
// 5) Chat actions
// ---------------------------------------------------------------------------
function createChat() {
  const chat = { id: newId(), title: DEFAULT_TITLE, messages: [] };
  chats.push(chat);
  activeChatId = chat.id;
  saveChats();
  return chat;
}

function startNewChat() {
  stopSpeaking();
  const current = getActiveChat();
  if (current && current.messages.length === 0) { renderMessages(); closeSidebar(); return; } // reuse empty chat
  createChat();
  renderSidebar(); renderMessages(); closeSidebar();
  els.input.focus();
}

function openChat(id) {
  stopSpeaking();
  activeChatId = id;
  saveChats(); renderSidebar(); renderMessages(); closeSidebar();
}

function deleteChat(id) {
  chats = chats.filter((chat) => chat.id !== id);
  if (activeChatId === id) {
    activeChatId = chats.length ? chats[chats.length - 1].id : null;
    stopSpeaking();
  }
  saveChats(); renderSidebar(); renderMessages();
}

function clearConversation() {
  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) return;
  if (!window.confirm("Clear all messages in this chat?")) return;
  stopSpeaking();
  chat.messages = [];
  chat.title = DEFAULT_TITLE;
  saveChats(); renderSidebar(); renderMessages();
}

async function sendMessage(rawText) {
  const text = (rawText || "").trim();
  if (!text || isLoading) return;                       // blocks empty + duplicate sends

  stopSpeaking();
  const chat = getActiveChat() || createChat();

  // History = earlier valid messages (errors are not sent to the AI)
  const history = chat.messages
    .filter((m) => !m.isError)
    .map((m) => ({ role: m.role, content: m.content }));

  chat.messages.push({ role: "user", content: text, time: new Date().toISOString() });
  if (chat.title === DEFAULT_TITLE) chat.title = text.length > 40 ? text.slice(0, 40) + "…" : text;
  els.input.value = "";
  autoResizeInput();
  saveChats(); renderSidebar();
  setLoading(true);

  try {
    const reply = await requestAiReply(text, history);
    chat.messages.push({ role: "assistant", content: reply, time: new Date().toISOString() });
    saveChats();
    setLoading(false);
    if (els.autoSpeak.checked) speak(reply);
  } catch (error) {
    chat.messages.push({ role: "assistant", content: error.message, time: new Date().toISOString(), isError: true });
    saveChats();
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// 6) Backend call
// ---------------------------------------------------------------------------
async function requestAiReply(message, history) {
  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
  } catch (networkError) {
    throw new Error("Cannot reach the Flask server. Is it still running in your terminal?");
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error("The server sent an invalid response. Please try again.");
  }

  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  if (typeof data.reply !== "string" || !data.reply) throw new Error("The server sent an invalid response.");
  return data.reply;
}

async function checkBackendHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    if (!data.ollama) {
      showBanner("Ollama is not running. Open the Ollama app, then refresh this page.");
    } else if (!data.model_installed) {
      showBanner("Model not installed. Run in a terminal:  ollama pull " + data.model);
    }
  } catch (error) {
    showBanner("Cannot reach the Flask server.");
  }
}

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.hidden = false;
}

// ---------------------------------------------------------------------------
// 7) Text-to-speech (SpeechSynthesis)
// ---------------------------------------------------------------------------
let speechSession = 0;   // lets us ignore events from cancelled speech

function textForSpeech(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block skipped) ")
    .replace(/[`*#_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoChunks(text, maxLength = 180) {
  // Browsers can cut off long utterances, so we speak sentence-sized chunks.
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current) { chunks.push(current); current = ""; }
    current += sentence;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function setSpeakingUi(isSpeaking) {
  els.stopSpeakBtn.hidden = !isSpeaking;
}

function speak(markdownText) {
  if (!("speechSynthesis" in window)) {
    showToast("Voice output is not supported in this browser.");
    return;
  }
  stopSpeaking();
  const cleanText = textForSpeech(markdownText);
  if (!cleanText) return;

  const session = ++speechSession;
  const chunks = splitIntoChunks(cleanText);
  let remaining = chunks.length;
  setSpeakingUi(true);

  chunks.forEach((chunk) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = "en-US";
    utterance.rate = 1;
    const finish = () => {
      if (session !== speechSession) return;
      remaining -= 1;
      if (remaining <= 0) setSpeakingUi(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

function stopSpeaking() {
  speechSession += 1;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setSpeakingUi(false);
}

// ---------------------------------------------------------------------------
// 8) Speech-to-text (SpeechRecognition)
// ---------------------------------------------------------------------------
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

function setListeningUi(listening) {
  isListening = listening;
  els.micBtn.classList.toggle("recording", listening);
  els.micBtn.setAttribute("aria-label", listening ? "Stop voice input" : "Start voice input");
  els.listening.hidden = !listening;
}

function toggleListening() {
  if (!SpeechRecognitionApi) {
    showToast("Voice input is not supported in this browser. Please use Google Chrome or Microsoft Edge.");
    return;
  }
  if (isListening) { recognition.stop(); return; }
  stopSpeaking();                         // don't let the AI talk over the user
  startListening();
}

function startListening() {
  recognition = new SpeechRecognitionApi();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = "";

  recognition.onstart = () => setListeningUi(true);

  recognition.onresult = (event) => {
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += transcript; else interimText += transcript;
    }
    els.input.value = (finalText + interimText).trim();
    autoResizeInput();
  };

  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone permission was denied. Allow the microphone in your browser's address bar and try again.",
      "service-not-allowed": "Microphone permission was denied. Allow the microphone in your browser's address bar and try again.",
      "no-speech": "I didn't hear anything. Click the microphone and try again.",
      "audio-capture": "No microphone was found. Please connect one and try again.",
      "network": "Speech recognition needs an internet connection in this browser.",
    };
    showToast(messages[event.error] || "Voice input error: " + event.error);
    finalText = "";                       // don't auto-send after an error
  };

  recognition.onend = () => {
    setListeningUi(false);
    if (finalText.trim()) sendMessage(finalText);   // auto-send what was recognised
  };

  try {
    recognition.start();
  } catch (error) {
    showToast("Could not start the microphone. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// 9) Events
// ---------------------------------------------------------------------------
function autoResizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

function openSidebar() { els.sidebar.classList.add("open"); els.overlay.classList.add("show"); }
function closeSidebar() { els.sidebar.classList.remove("open"); els.overlay.classList.remove("show"); }

els.sendBtn.addEventListener("click", () => sendMessage(els.input.value));
els.input.addEventListener("input", autoResizeInput);
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(els.input.value); }
});
els.micBtn.addEventListener("click", toggleListening);
els.stopSpeakBtn.addEventListener("click", stopSpeaking);
els.newChatBtn.addEventListener("click", startNewChat);
els.clearBtn.addEventListener("click", clearConversation);
els.menuBtn.addEventListener("click", openSidebar);
els.overlay.addEventListener("click", closeSidebar);

els.chatList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "open") openChat(button.dataset.id);
  if (button.dataset.action === "delete") deleteChat(button.dataset.id);
});

els.messages.addEventListener("click", (event) => {
  const suggestion = event.target.closest(".suggestion");
  if (suggestion) { sendMessage(suggestion.textContent); return; }

  const button = event.target.closest("button[data-action]");
  const chat = getActiveChat();
  if (!button || !chat) return;
  const message = chat.messages[Number(button.dataset.index)];
  if (!message) return;

  if (button.dataset.action === "speak") speak(message.content);
  if (button.dataset.action === "stop") stopSpeaking();
  if (button.dataset.action === "copy") {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(message.content)
        .then(() => showToast("Copied to clipboard"))
        .catch(() => showToast("Could not copy. Please select the text manually."));
    } else {
      showToast("Copy is not supported in this browser.");
    }
  }
});

window.addEventListener("beforeunload", stopSpeaking);

// ---- Start-up ----
if (!getActiveChat()) activeChatId = chats.length ? chats[chats.length - 1].id : null;
renderSidebar();
renderMessages();
checkBackendHealth();
if (!SpeechRecognitionApi) els.micBtn.title = "Voice input is not supported in this browser";
