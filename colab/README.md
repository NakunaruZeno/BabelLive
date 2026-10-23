# BabelLive — Google Colab Backend

This directory contains the official Jupyter Notebook (`BabelLive_Backend.ipynb`) designed to host the BabelLive AI backend on Google Colab with a free T4 GPU instance.

---

## Architecture Overview

The backend pipeline leverages:
- **Kotoba-Whisper v2.0 (`kotoba-tech/kotoba-whisper-v2.0`):** Specialized Japanese speech recognition model trained on 7M ReazonSpeech audio samples (~8.4% CER, 6.3x faster than original Whisper large-v3).
- **Qwen2.5-3B-Instruct (`Qwen/Qwen2.5-3B-Instruct`):** Context-aware causal language model fine-tuned for high-fidelity dialogue and spoken subtitle translation.
- **FastAPI & WebSocket (`/ws/live`):** Streams uncompressed 16kHz Int16 PCM audio directly from the Chrome extension offscreen worker for minimal end-to-end latency.
- **Voice Activity Detection & Hallucination Suppression:** Energy-based RMS audio filtering combined with token deduplication to avoid repetitive caption loops on silent or noisy live streams.
- **Persistent Storage:** Caches pip wheels, PyTorch assets, and Hugging Face weights to Google Drive (`/content/drive/MyDrive/BabelLive_Cache/`) to eliminate re-downloading overhead on subsequent runs.

---

## Setup & Deployment Guide

### Step 1: Upload Notebook to Google Colab
1. Navigate to [Google Colab](https://colab.research.google.com/).
2. Select **Upload** and choose `colab/BabelLive_Backend.ipynb`.
3. In the top menu, select **File** -> **Save a copy in Drive**. This produces a permanent notebook URL formatted as:
   `https://colab.research.google.com/drive/1a2b3c4d5e...`
   Copy this link if you want to utilize the extension's automated one-click launcher.
4. Ensure the runtime is set to GPU:
   - Select **Runtime** -> **Change runtime type** -> choose **T4 GPU** -> click **Save**.

---

### Step 2: Configure Authentication Secrets
1. Register a free account at [ngrok.com](https://ngrok.com/) and retrieve your authentication token from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).
2. In the left sidebar of Google Colab, open the **Secrets** (Key icon) tab:
   - Add a new secret:
     - **Name:** `NGROK_AUTHTOKEN`
     - **Value:** `<Your ngrok authtoken>`
   - (Optional - if you have an assigned ngrok domain):
     - **Name:** `NGROK_STATIC_DOMAIN`
     - **Value:** `<your-subdomain.ngrok-free.app>`
   - (Optional - for faster Hugging Face model downloads):
     - **Name:** `HF_TOKEN`
     - **Value:** `<Your Hugging Face user access token>`
   - Enable **Notebook access** for all configured secrets.

---

### Step 3: Run the Server

#### Method A: Automated One-Click Launch (Recommended)
1. Open the BabelLive extension popup in your browser.
2. Paste your Google Colab Drive link into **Colab Notebook URL**.
3. Click **Launch & Start Subtitles**.
4. The extension will automatically open the Colab notebook tab, initiate execution (Ctrl+F9), capture the exposed WebSocket address upon server readiness, and activate live subtitles on your active YouTube tab.

#### Method B: Manual Execution
1. In Google Colab, select **Runtime** -> **Run all** (Ctrl+F9).
2. When prompted, grant Google Drive mounting permissions to enable persistent model caching.
3. Once Cell 4 initializes, the console outputs:
   ```text
   ============================================================
   BABELLIVE JAPANESE AI BACKEND IS ACTIVE
   WebSocket URL (Paste into BabelLive Popup):
      wss://your-tunnel.ngrok-free.dev/ws/live
   HTTP Endpoint: https://your-tunnel.ngrok-free.dev
   STT Model: Kotoba-Whisper v2.0 (kotoba-tech/kotoba-whisper-v2.0)
   Translation Model: Qwen/Qwen2.5-3B-Instruct
   ============================================================
   ```
4. Copy the `wss://...` URL, paste it into **Colab WebSocket URL** in the BabelLive popup, and toggle the master switch.

---

## Security & Privacy Considerations

- Tokens and credentials stored in Colab Secrets remain strictly confidential to your Google account.
- The WebSocket server accepts encrypted live audio chunks (`wss://`) and processes inference on your dedicated Colab runtime.
