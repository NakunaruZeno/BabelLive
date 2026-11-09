# BabelLive

[English](README.md) | [Tiếng Việt](README.vi.md) | [日本語](README.ja.md)

Real-time bilingual AI subtitling extension for YouTube livestreams and videos.

BabelLive captures tab audio, performs low-latency speech recognition and contextual machine translation, and renders high-legibility dual-language subtitles directly over the active HTML5 video player.

---

## Architectural Overview

BabelLive operates as a decoupled client-server system designed for low-latency live media translation:

```text
Browser Tab (YouTube)
  │
  ├─► chrome.tabCapture (Audio Stream)
  │     │
  │     ▼
  │   Offscreen Document (AudioContext / AudioWorklet 16kHz PCM)
  │     │ (Direct 16kHz Int16 PCM Chunks — 128ms frames)
  │     ▼
  │   WebSocket Channel (wss://)
  │     │
  │     ▼
  │   AI Backend (FastAPI / Modal Serverless T4 or Google Colab T4)
  │     ├─► Socket Frame Coalescing & RMS Energy VAD
  │     ├─► Kotoba-Whisper v2.0 (Speech Recognition)
  │     └─► Qwen2.5-7B-Instruct 4-bit NF4 (Contextual Translation)
  │     │
  │     ▼
  │   WebSocket JSON Message (Interim & Final Captions)
  │     │
  │     ▼
  └─◄ Content Script (DOM Overlay & Video Player Hook)
```

1. **Tab Capture Pipeline:** Captures internal tab audio via `chrome.tabCapture` inside a Chrome Manifest V3 offscreen document without muting tab audio.
2. **Off-Thread AudioWorklet PCM Streaming:** Resamples audio to 16kHz Int16 mono PCM in 128ms frames via `AudioWorkletProcessor` and transmits raw chunks with WebSocket backpressure protection.
3. **Speech Recognition (ASR):** Powered by `kotoba-tech/kotoba-whisper-v2.0` (trained on 7M ReazonSpeech samples, ~8.4% CER, 6.3x faster than Whisper large-v3).
4. **Contextual Translation (LLM):** Powered by `Qwen/Qwen2.5-7B-Instruct` (4-bit NF4 via BitsAndBytes) with rolling dialogue context, preserving colloquial expressions, VTuber/anime terminology, and proper names.
5. **DOM Subtitle Overlay:** Renders broadcast-grade dual-language subtitles (`Anime`, `Cinema`, `Minimal`) with position locking, clamped percentage dragging, and keyboard shortcuts (`Alt+B`) directly inside the YouTube video player.

---

## Key Features

- **Real-Time Streaming Inference:** Streaming WebSocket architecture providing both real-time predictive interim transcriptions and finalized sentence translations.
- **Voice Activity Detection & Hallucination Suppression:** Energy-based thresholding (RMS) and duplicate token suppression prevent loop artifacts during silences and background music.
- **Persistent Model Caching:** Uses Google Drive caching (`/content/drive/MyDrive/BabelLive_Cache/`) to eliminate repetitive dependency and weight downloads across Colab sessions.
- **Automated Colab Runner:** Automated background script initiates notebook execution, dismisses author dialogs, and acquires the WebSocket address with a single click.
- **Flexible Styling:** Includes Anime, Cinema, and Minimal subtitle styling presets with interactive dragging and font-size adjustments.
- **Bilingual Display:** Toggles both original transcription and target translation simultaneously.

---

## Repository Structure

```text
BabelLive/
├── colab/                      # Google Colab GPU backend
│   ├── BabelLive_Backend.ipynb # Colab notebook (Kotoba-Whisper + Qwen2.5 + WebSocket)
│   └── README.md               # Colab deployment instructions
│
├── modal_backend/              # Modal Labs Serverless GPU backend
│   ├── app.py                  # Zero-cold-start ASGI WebSocket backend
│   ├── requirements.txt        # Local CLI dependency
│   └── README.md               # Modal cloud deployment guide
│
└── src/                        # Chrome Extension (Manifest V3)
    ├── icons/                  # Extension icons (16, 32, 48, 128)
    ├── manifest.json           # Extension configuration and permissions
    ├── popup.html / popup.css  # Minimalist Studio popup interface
    ├── popup.js                # State management and endpoint controller
    ├── content.js              # Video player hook and subtitle overlay
    ├── overlay.css             # Broadcast subtitle presets & minibar styles
    ├── offscreen.html / .js    # Tab audio capture and 16kHz PCM streaming
    ├── audio-worklet-processor.js # Off-thread Float32-to-Int16 audio worklet
    ├── service-worker.js       # Background message router and session lifecycle
    └── colab-automator.js      # Automated Colab notebook runner
```

---

## Installation & Setup

### 1. Load the Chrome Extension

1. Clone or download this repository:
   ```bash
   git clone https://github.com/NakunaruZeno/BabelLive.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the upper-right corner.
4. Click **Load unpacked** and select the `src/` directory.

### 2. Launch the AI Backend (Google Colab)

1. Open [Google Colab](https://colab.research.google.com/) and upload `colab/BabelLive_Backend.ipynb`.
2. Save a copy to your Google Drive via **File** -> **Save a copy in Drive**.
3. Set runtime hardware to **T4 GPU** under **Runtime** -> **Change runtime type**.
4. Configure your `NGROK_AUTHTOKEN` in the Colab **Secrets** tab (Key icon) with notebook access enabled.
5. In the BabelLive popup:
   - Paste the Google Drive link into **Colab Notebook URL** and click **Launch & Start Subtitles**, or
   - Execute the notebook manually (Ctrl+F9), copy the `wss://.../ws/live` URL, paste it into **Colab WebSocket URL**, and enable the master switch.

---

## Technology Stack

- **Extension Framework:** Chrome Extensions API (Manifest V3), Web Audio API (`AudioWorkletNode`), DOM `MutationObserver`.
- **Backend Service:** Python 3.10+, FastAPI, Uvicorn, WebSockets, Modal Labs Serverless GPU / PyNgrok.
- **Speech Recognition:** Hugging Face Transformers, `kotoba-tech/kotoba-whisper-v2.0`, PyTorch.
- **Translation:** `Qwen/Qwen2.5-7B-Instruct` (4-bit NF4), BitsAndBytes, Accelerate.

---

## Security & Privacy

- Audio captured via `chrome.tabCapture` is streamed directly to your private Colab runtime session.
- Authentication tokens and configurations are stored locally inside `chrome.storage.local`.
- No audio or transcription data is retained or shared with third parties.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
