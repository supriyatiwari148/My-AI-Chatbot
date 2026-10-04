"""
AI Voice Assistant - Flask backend.

Responsibilities:
  * Serve the web page (templates/index.html + static files)
  * Receive chat messages from the browser
  * Forward the conversation to a local Ollama model
  * Return the AI reply (or a friendly error) as JSON
"""

import os

import requests
from flask import Flask, jsonify, render_template, request

# ---------------------------------------------------------------------------
# Configuration (can be overridden with environment variables)
# ---------------------------------------------------------------------------
OLLAMA_CHAT_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/chat")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")

# Cloud mode: if GROQ_API_KEY is set (e.g. on Render), the app uses Groq's free
# API instead of a local Ollama. Without a key it keeps using Ollama locally.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
USE_GROQ = bool(GROQ_API_KEY)
ACTIVE_MODEL = GROQ_MODEL if USE_GROQ else OLLAMA_MODEL
REQUEST_TIMEOUT_SECONDS = 180      # small models on a laptop CPU can be slow
MAX_MESSAGE_LENGTH = 2000          # characters allowed in one user message
MAX_HISTORY_MESSAGES = 20          # how many previous messages we send to the AI

SYSTEM_PROMPT = (
    "You are AI Voice Assistant, a friendly and helpful assistant. "
    "Explain things clearly in simple language, like a good teacher. "
    "Your answers may be read aloud, so keep them concise and avoid large tables. "
    "Put any code inside Markdown code blocks. "
    "Use the earlier messages in the conversation to understand follow-up questions."
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024  # reject request bodies over 1 MB


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
def error_response(message, status_code):
    """Return a clean JSON error."""
    return jsonify({"error": message}), status_code


def clean_history(raw_history):
    """Keep only valid {role, content} items and only the most recent ones."""
    if not isinstance(raw_history, list):
        return []
    cleaned = []
    for item in raw_history:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            cleaned.append({"role": role, "content": content.strip()[:MAX_MESSAGE_LENGTH * 4]})
    return cleaned[-MAX_HISTORY_MESSAGES:]


def ask_ollama(messages):
    """Send the messages to Ollama and return the reply text.

    Raises requests exceptions, which the route handles.
    """
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + messages,
        "stream": False,
    }
    response = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
    return response


def ask_groq(messages):
    """Send the messages to Groq (OpenAI-compatible API) and return the response."""
    payload = {
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + messages,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
    return requests.post(GROQ_CHAT_URL, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------
@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'"
    )
    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", model_name=ACTIVE_MODEL, cloud_mode=USE_GROQ)


@app.route("/api/health")
def health():
    """Tell the frontend whether the AI backend is reachable and the model is ready."""
    if USE_GROQ:
        return jsonify({"ollama": True, "model": GROQ_MODEL, "model_installed": True})
    try:
        tags_url = OLLAMA_CHAT_URL.replace("/api/chat", "/api/tags")
        response = requests.get(tags_url, timeout=5)
        installed = [m.get("name", "") for m in response.json().get("models", [])]
        model_ready = any(name == OLLAMA_MODEL or name.startswith(OLLAMA_MODEL + ":") for name in installed)
        return jsonify({"ollama": True, "model": OLLAMA_MODEL, "model_installed": model_ready})
    except (requests.exceptions.RequestException, ValueError):
        return jsonify({"ollama": False, "model": OLLAMA_MODEL, "model_installed": False})


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error_response("Invalid request. Please send JSON.", 400)

    user_message = data.get("message")
    if not isinstance(user_message, str) or not user_message.strip():
        return error_response("Please type a message before sending.", 400)
    user_message = user_message.strip()
    if len(user_message) > MAX_MESSAGE_LENGTH:
        return error_response(f"Message is too long (maximum {MAX_MESSAGE_LENGTH} characters).", 400)

    # Previous messages + the new message = full conversation context
    messages = clean_history(data.get("history")) + [{"role": "user", "content": user_message}]

    if USE_GROQ:
        try:
            ai_response = ask_groq(messages)
        except requests.exceptions.Timeout:
            return error_response("The AI took too long to answer. Please try again.", 504)
        except requests.exceptions.RequestException:
            return error_response("Could not reach the AI service. Please try again.", 502)

        if ai_response.status_code == 401:
            return error_response("The AI service rejected the API key. Check GROQ_API_KEY.", 502)
        if ai_response.status_code == 429:
            return error_response("Too many requests right now. Please wait a moment and try again.", 429)
        if ai_response.status_code != 200:
            print("Groq error:", ai_response.status_code, ai_response.text[:300])
            return error_response("The AI service returned an error. Please try again.", 502)

        try:
            reply = ai_response.json()["choices"][0]["message"]["content"].strip()
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            return error_response("Received an invalid response from the AI service.", 502)
    else:
        try:
            ollama_response = ask_ollama(messages)
        except requests.exceptions.ConnectionError:
            return error_response(
                "Cannot reach Ollama. Make sure the Ollama app is running (open it from the Start menu).", 503
            )
        except requests.exceptions.Timeout:
            return error_response("The AI took too long to answer. Try a shorter question or a smaller model.", 504)
        except requests.exceptions.RequestException:
            return error_response("Something went wrong while contacting the AI model.", 502)

        if ollama_response.status_code == 404:
            return error_response(
                f"The model '{OLLAMA_MODEL}' is not installed. Run:  ollama pull {OLLAMA_MODEL}", 404
            )
        if ollama_response.status_code != 200:
            try:
                detail = ollama_response.json().get("error", "")
            except ValueError:
                detail = ollama_response.text[:200]
            print("Ollama error:", ollama_response.status_code, detail)
            return error_response(f"The AI model returned an error: {detail}", 502)

        try:
            reply = ollama_response.json()["message"]["content"].strip()
        except (ValueError, KeyError, TypeError, AttributeError):
            return error_response("Received an invalid response from the AI model.", 502)

    if not reply:
        return error_response("The AI returned an empty answer. Please try again.", 502)

    return jsonify({"reply": reply})


# ---------------------------------------------------------------------------
# JSON error handlers (so the browser never receives raw Python error pages)
# ---------------------------------------------------------------------------
@app.errorhandler(413)
def too_large(_error):
    return error_response("Request is too large.", 413)


@app.errorhandler(405)
def method_not_allowed(_error):
    return error_response("Method not allowed.", 405)


@app.errorhandler(500)
def server_error(_error):
    return error_response("Internal server error. Please try again.", 500)


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=debug_mode)
