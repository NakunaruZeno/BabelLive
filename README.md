# BabelLive

[English](README.md) | [Tiếng Việt](docs/README.vi.md) | [日本語](docs/README.ja.md)

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
├── backend/                       # AI Streaming Backends
│   ├── colab/                     # Google Colab GPU environment
│   │   ├── BabelLive_Backend.ipynb# Kotoba-Whisper + Qwen2.5 + WebSocket notebook
│   │   └── README.md              # Free Colab T4 setup guide
│   └── modal/                     # Modal Labs Serverless GPU environment
│       ├── app.py                 # ASGI WebSocket backend on T4/A10G
│       ├── requirements.txt       # Modal CLI dependencies
│       └── README.md              # Cloud deployment guide
│
├── docs/                          # Multilingual Documentation & Guides
│   ├── README.vi.md               # Hướng dẫn tiếng Việt
│   └── README.ja.md               # 日本語ドキュメント
│
├── src/                           # Chrome Extension (Manifest V3)
│   ├── background/
│   │   └── service-worker.js      # Session lifecycle & message routing
│   ├── content/
│   │   ├── content.js             # Player hook, subtitle overlay, keyboard shortcuts
│   │   ├── overlay.css            # Broadcast subtitle styling presets (Anime, Cinema, Minimal)
│   │   └── colab-automator.js     # One-click Colab auto-launcher script
│   ├── popup/
│   │   ├── popup.html             # Minimalist Studio popup interface
│   │   ├── popup.css              # Dark theme styling, hairline borders
│   │   └── popup.js               # Reactive UI controller & settings manager
│   ├── offscreen/
│   │   ├── offscreen.html         # Offscreen audio capture host
│   │   ├── offscreen.js           # AudioContext, monitor loopback & WebSocket sender
│   │   └── audio-worklet-processor.js # 128ms zero-copy Int16 PCM AudioWorklet
│   ├── icons/                     # Transparent SVG & PNG icons
│   │   ├── icon.svg
│   │   └── icon*.png
│   └── manifest.json              # Extension manifest V3 descriptor
│
├── .gitignore                     # Git ignore rules
├── LICENSE                        # MIT License
└── README.md                      # Primary English documentation
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

1. Open [Google Colab](https://colab.research.google.com/) and upload `backend/colab/BabelLive_Backend.ipynb`.
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
