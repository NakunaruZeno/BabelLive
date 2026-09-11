# BabelLive 🌐🎤

**Real-time bilingual AI subtitling extension for YouTube streams and videos.**  
*Tiện ích mở rộng cung cấp phụ đề song ngữ theo thời gian thực sử dụng AI cho các luồng trực tiếp và video trên YouTube.*

## 📖 Project Overview

BabelLive is a powerful Chrome Extension built with Manifest V3 that provides real-time bilingual subtitling for YouTube streams and videos. By leveraging the `tabCapture` API, it streams internal tab audio (without requiring a physical microphone) to **Groq Whisper** or the multimodal **Google Gemini 2.5 Flash** model for fast, accurate transcription and translation.

## ✨ Key Features

- **Internal Audio Loopback Capture:** Captures audio directly from the Chrome tab using the `tabCapture` API. No virtual audio cables or physical microphone permissions required.
- **Real-time AI transcription:** Powered by Groq Whisper or Google Gemini 2.5 Flash for rapid speech-to-text and translation across multiple languages.
- **Custom Visual Presets:** Enjoy beautiful, customizable overlay aesthetics including **Anime** and **Cinema** styles.
- **YouTube Fullscreen Compatibility:** The subtitle overlay is injected directly into the YouTube player, ensuring perfect display even in fullscreen mode.
- **Side Panel Integration:** Easily manage your translation sessions, configure language pairs, and adjust settings via the Chrome Side Panel.

## 🛠 Architecture & Tech Stack

- **Framework:** Chrome Extension Manifest V3
- **Audio Streaming:** `chrome.tabCapture` API & Offscreen Documents
- **AI/ML:** Groq Whisper or Google Gemini 2.5 Flash (Multimodal Audio/Text)
- **Frontend / Overlay:** Vanilla JavaScript, HTML5, and CSS3 injected via Content Scripts

## 🚀 Installation Guide

BabelLive can be installed locally via Developer Mode:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NakunaruZeno/BabelLive.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click on the **Load unpacked** button.
5. Select the `BabelLive` project folder (the directory containing `manifest.json`).
6. The extension is now installed and ready to use!

## ⚙️ Setup & API Configuration

To enable AI translation, provide an API key for the cloud provider selected in the popup:

1. Get an API key from Google AI Studio or Groq.
2. Open the BabelLive extension via the Chrome toolbar icon or the Side Panel.
3. Select the matching provider and paste its API key into the settings configuration.
4. Select your source language and target language pairs.
5. Navigate to any YouTube video or livestream and start the extension.

## 🔒 Security Notice

**Your keys are safe.** BabelLive respects your privacy and security. API keys and user configurations are stored strictly within your browser's local storage (`chrome.storage.local`). **Your credentials are never exposed, sent to telemetry, or transmitted to any third-party servers other than the official Google Gemini API.**
