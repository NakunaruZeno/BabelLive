"""
BabelLive — Modal Labs Serverless GPU Backend
Hosts Kotoba-Whisper v2.0 (ASR) + Qwen2.5-7B-Instruct (4-bit NF4 LLM) on Nvidia T4/L4.

Features:
- Zero-Download Startup: Models pre-cached inside container image during build phase.
- Auto-scaling: Scales down to 0 replicas after 2 minutes of inactivity (zero cost when idle).
- Protocol Compatible: Exposes /ws/live for 16kHz Int16 PCM streaming directly from BabelLive.
"""

import asyncio
import io
import json
import logging
import os
import subprocess
import time
import modal
import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
# 1. Model & Environment Configurations
# ─────────────────────────────────────────────────────────────────────────────
STT_MODEL_ID = "kotoba-tech/kotoba-whisper-v2.0"
LLM_MODEL_ID = "Qwen/Qwen2.5-7B-Instruct"

LANG_MAP = {
    "en": "English", "ja": "Japanese", "zh": "Chinese",
    "ko": "Korean", "vi": "Vietnamese", "fr": "French",
    "de": "German", "es": "Spanish", "ru": "Russian", "th": "Thai",
    "auto": "the source language"
}

HALLUCINATIONS = {
    "ごめん", "ごめんね", "ごめんなさい", "はい", "うん",
    "ご視聴ありがとうございました", "チャンネル登録お願いします",
    "ありがとうございました", "お疲れ様でした"
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Image Build Definition & Model Pre-caching (Zero Cold-Start Download)
# ─────────────────────────────────────────────────────────────────────────────
def download_models_to_image():
    """Executed during `modal deploy` container build step to pre-cache weights."""
    from huggingface_hub import snapshot_download
    print(f"[Build Step] Pre-caching STT weights: {STT_MODEL_ID}...")
    snapshot_download(repo_id=STT_MODEL_ID)
    print(f"[Build Step] Pre-caching LLM weights: {LLM_MODEL_ID}...")
    snapshot_download(repo_id=LLM_MODEL_ID)
    print("[Build Step] Model weights successfully baked into container layer.")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch>=2.2.0",
        "transformers>=4.42.0",
        "accelerate>=0.30.0",
        "bitsandbytes>=0.43.0",
        "fastapi>=0.110.0",
        "uvicorn[standard]>=0.30.0",
        "websockets>=12.0",
        "soundfile>=0.12.1",
        "soxr>=0.3.7",
        "numpy>=1.24.0",
        "huggingface_hub>=0.23.0",
    )
    .run_function(download_models_to_image)
)

app = modal.App("babellive-backend")

# ─────────────────────────────────────────────────────────────────────────────
# 3. Audio Stream Decoder (16kHz PCM & WebM/Opus Fallback)
# ─────────────────────────────────────────────────────────────────────────────
class AudioStreamDecoder:
    """Decodes incoming real-time audio streams (16kHz Int16 PCM or WebM/Opus)."""
    def __init__(self):
        self.webm_header = bytearray()
        self.accumulated_webm = bytearray()
        self.last_decoded_samples = 0
        self.is_webm = None
        self.chunk_count = 0

    def reset_stream(self):
        if self.is_webm and self.webm_header:
            self.accumulated_webm = bytearray(self.webm_header)
            self.last_decoded_samples = 0
        else:
            self.accumulated_webm = bytearray()
            self.last_decoded_samples = 0

    def decode(self, data: bytes) -> np.ndarray:
        if not data or len(data) == 0:
            return np.array([], dtype=np.float32)

        self.chunk_count += 1
        if self.is_webm is None:
            if data.startswith(b'\x1a\x45\xdf\xa3') or b'webm' in data[:64] or data.startswith(b'\x1f\x43\xb6\x75'):
                self.is_webm = True
            else:
                self.is_webm = False

        if not self.is_webm:
            try:
                if len(data) % 2 != 0:
                    data = data[:len(data) - 1]
                return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            except Exception:
                return np.array([], dtype=np.float32)

        # WebM Fallback
        if data.startswith(b'\x1a\x45\xdf\xa3'):
            c_idx = data.find(b'\x1f\x43\xb6\x75')
            self.webm_header = bytearray(data[:c_idx]) if c_idx > 0 else bytearray(data[:2048])
            self.accumulated_webm = bytearray(data)
            self.last_decoded_samples = 0
        else:
            if len(self.accumulated_webm) == 0 and self.webm_header:
                self.accumulated_webm = bytearray(self.webm_header)
            self.accumulated_webm.extend(data)

        try:
            cmd = [
                'ffmpeg', '-y', '-f', 'matroska', '-i', 'pipe:0',
                '-f', 's16le', '-acodec', 'pcm_s16le',
                '-ar', '16000', '-ac', '1', 'pipe:1'
            ]
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            out, _ = proc.communicate(input=bytes(self.accumulated_webm), timeout=2.0)
            if out and len(out) >= 2:
                if len(out) % 2 != 0:
                    out = out[:len(out) - 1]
                full_audio = np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768.0
                new_samples = full_audio[self.last_decoded_samples:]
                self.last_decoded_samples = len(full_audio)
                return new_samples
        except Exception:
            pass

        return np.array([], dtype=np.float32)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Serverless GPU Service Class
# ─────────────────────────────────────────────────────────────────────────────
@app.cls(
    gpu="T4",
    image=image,
    scaledown_window=120,         # Scale down to 0 when idle for 2 minutes
)
class BabelLiveService:
    @modal.enter()
    def initialize_models(self):
        """Loads both Kotoba-Whisper and Qwen2.5 into GPU VRAM once on container start."""
        import torch
        from transformers import pipeline, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        logging.basicConfig(level=logging.INFO)
        self.logger = logging.getLogger("BabelLive-Modal")
        self.logger.info("[Init] Initializing Kotoba-Whisper v2.0 on CUDA...")

        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        self.asr_pipe = pipeline(
            "automatic-speech-recognition",
            model=STT_MODEL_ID,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device=device,
        )
        self.logger.info("[Init] Kotoba-Whisper v2.0 loaded successfully.")

        self.logger.info("[Init] Initializing Qwen2.5-7B-Instruct (4-bit NF4)...")
        self.llm_tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID)

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True
        )

        self.llm_model = AutoModelForCausalLM.from_pretrained(
            LLM_MODEL_ID,
            quantization_config=bnb_config,
            device_map="auto"
        )
        self.llm_model.eval()
        self.logger.info("[Init] Qwen2.5-7B-Instruct (4-bit NF4) loaded successfully.")

    def transcribe_speech(self, audio_np: np.ndarray, lang: str = "ja") -> str:
        """Runs Kotoba-Whisper ASR inference on 16kHz audio buffer."""
        if len(audio_np) < 16000 * 0.4:
            return ""
        try:
            gen_kwargs = {"task": "transcribe"}
            if lang and lang != "auto":
                gen_kwargs["language"] = lang
            res = self.asr_pipe({"raw": audio_np, "sampling_rate": 16000}, generate_kwargs=gen_kwargs)
            return res.get("text", "").strip()
        except Exception as e:
            self.logger.error(f"[ASR Error] {e}")
            return ""

    def predict_translation(
        self,
        source_text: str,
        is_final: bool = False,
        source_lang: str = "ja",
        target_lang: str = "vi"
    ) -> str:
        """Runs Qwen2.5-7B contextual subtitle translation."""
        import torch

        if not source_text.strip():
            return ""

        src_name = LANG_MAP.get(source_lang, source_lang)
        tgt_name = LANG_MAP.get(target_lang, target_lang)

        if is_final:
            if source_lang == "ja" and target_lang == "vi":
                sys_prompt = (
                    "You are an expert Japanese-to-Vietnamese subtitle translator specialized in live streams, VTubers, anime, gaming, and talk shows.\n"
                    "Strict Translation Guidelines:\n"
                    "1. Translate spoken Japanese into natural, expressive, colloquial Vietnamese suitable for live streaming subtitles.\n"
                    "2. NEVER translate Japanese personal names, VTuber names, or character names into Sino-Vietnamese (Hán-Việt) phonetics (e.g., 大空スバル must be translated as 'Subaru' or 'Oozora Subaru', NEVER 'Đào Khôn' or 'Đại Không'). Keep proper names in Romaji or commonly accepted forms.\n"
                    "3. Translate streaming and gaming terms naturally using common community expressions (e.g., デビュー -> 'debut' or 'ra mắt', オフ -> 'off-collab' or 'gặp ngoài đời', ホロメン -> 'thành viên Hololive').\n"
                    "4. NEVER output Chinese characters (Hanzi) or foreign symbols in the Vietnamese output.\n"
                    "5. Accurately interpret colloquial Japanese contractions, particles, and spoken homophones.\n"
                    "6. Return ONLY the direct Vietnamese translation. Do NOT include notes, explanations, or quotes."
                )
            else:
                sys_prompt = (
                    f"You are an expert {src_name}-to-{tgt_name} subtitle translator for live streams.\n"
                    f"1. Translate spoken {src_name} naturally and idiomatically into colloquial {tgt_name}.\n"
                    f"2. Keep proper names, streamer tags, and brand names intact without translating them literally.\n"
                    f"3. Return ONLY the clean {tgt_name} translation without notes, quotes, or explanations."
                )
            user_prompt = source_text
        else:
            if source_lang == "ja" and target_lang == "vi":
                sys_prompt = (
                    "You are a real-time predictive interpreter translating incomplete spoken Japanese into Vietnamese.\n"
                    "Strict Rules:\n"
                    "1. Predictively translate the current spoken fragment into natural, colloquial Vietnamese ending with '...'.\n"
                    "2. Keep Japanese names in Romaji (e.g., Subaru, Pekora). Never translate names into Sino-Vietnamese.\n"
                    "3. Return ONLY the predictive Vietnamese fragment ending with '...'. Do not include quotes or explanations."
                )
            else:
                sys_prompt = (
                    f"You are a real-time predictive interpreter translating spoken {src_name} into {tgt_name}.\n"
                    f"The speaker is currently speaking and the sentence is incomplete.\n"
                    f"Predictively translate the fragment into fluent {tgt_name} ending with '...'. Return ONLY the fragment translation."
                )
            user_prompt = f"Incomplete fragment: {source_text}"

        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt}
        ]

        prompt = self.llm_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.llm_tokenizer([prompt], return_tensors="pt").to(self.llm_model.device)

        with torch.no_grad():
            output_ids = self.llm_model.generate(
                **inputs,
                max_new_tokens=64 if not is_final else 128,
                do_sample=False,
                pad_token_id=self.llm_tokenizer.eos_token_id
            )
        generated = output_ids[0][len(inputs.input_ids[0]):]
        return self.llm_tokenizer.decode(generated, skip_special_tokens=True).strip()

    # ─────────────────────────────────────────────────────────────────────────
    # 5. FastAPI & WebSocket ASGI Server Mount
    # ─────────────────────────────────────────────────────────────────────────
    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse

        web_app = FastAPI(title="BabelLive Modal Backend")
        web_app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        @web_app.get("/health")
        @web_app.get("/ping")
        async def health():
            return {
                "status": "ok",
                "backend": "modal-serverless-gpu",
                "stt_model": STT_MODEL_ID,
                "llm_model": LLM_MODEL_ID
            }

        @web_app.websocket("/ws/live")
        async def websocket_live(websocket: WebSocket):
            await websocket.accept()
            source_lang = websocket.query_params.get("source_lang", "ja") or "ja"
            target_lang = websocket.query_params.get("target_lang", "vi") or "vi"
            print(
                f"[BabelLive] Extension connected to Modal WebSocket session ({source_lang} -> {target_lang}).",
                flush=True,
            )

            decoder = AudioStreamDecoder()
            accumulated_audio = np.array([], dtype=np.float32)
            last_word_count = 0
            last_translation_time = time.time()
            last_interim_text = ""
            last_final_text = ""

            try:
                while True:
                    packet = await websocket.receive()
                    if packet.get("type") == "websocket.disconnect":
                        break

                    if "text" in packet and packet["text"]:
                        try:
                            cfg = json.loads(packet["text"])
                            if cfg.get("type") == "config":
                                source_lang = cfg.get("source_lang", source_lang) or source_lang
                                target_lang = cfg.get("target_lang", target_lang) or target_lang
                        except Exception:
                            pass
                        continue

                    message = packet.get("bytes")
                    if not message:
                        continue

                    chunk_audio = decoder.decode(message)
                    if len(chunk_audio) == 0:
                        continue

                    accumulated_audio = np.concatenate((accumulated_audio, chunk_audio))

                    # Audio window maintenance
                    if len(accumulated_audio) > 16000 * 8:
                        accumulated_audio = accumulated_audio[-16000 * 4:]
                        decoder.reset_stream()

                    if len(accumulated_audio) < 16000 * 0.5:
                        continue

                    # Voice Activity Detection (RMS energy threshold)
                    rms = np.sqrt(np.mean(accumulated_audio**2))
                    if rms < 0.007:
                        if len(accumulated_audio) > 16000 * 2.5:
                            accumulated_audio = np.array([], dtype=np.float32)
                            decoder.reset_stream()
                        continue

                    # Execute ASR in worker thread to prevent event-loop starvation
                    current_text = await asyncio.to_thread(
                        self.transcribe_speech, accumulated_audio, source_lang
                    )

                    if not current_text:
                        if len(accumulated_audio) > 16000 * 4:
                            accumulated_audio = accumulated_audio[-16000 * 2:]
                        continue

                    # Hallucination suppression during low-energy noise
                    if rms < 0.015 and current_text in HALLUCINATIONS:
                        continue

                    now = time.time()
                    is_punctuation = current_text[-1] in [".", "!", "?", "。", "！", "？"]

                    # Sentence boundary reached -> Finalize translation
                    if is_punctuation or (len(accumulated_audio) > 16000 * 4.5):
                        if current_text == last_final_text:
                            accumulated_audio = np.array([], dtype=np.float32)
                            decoder.reset_stream()
                            continue

                        last_final_text = current_text
                        last_interim_text = ""

                        translation = await asyncio.to_thread(
                            self.predict_translation, current_text, True, source_lang, target_lang
                        )

                        await websocket.send_json({
                            "type": "final",
                            "original": current_text,
                            "translated": translation,
                            "source_lang": source_lang,
                            "target_lang": target_lang
                        })

                        keep_len = int(16000 * 0.3)
                        accumulated_audio = (
                            accumulated_audio[-keep_len:]
                            if len(accumulated_audio) > keep_len
                            else np.array([], dtype=np.float32)
                        )
                        decoder.reset_stream()
                        last_word_count = 0
                        last_translation_time = now
                    else:
                        # Interim preview (streaming real-time preview)
                        if current_text != last_interim_text and (
                            (now - last_translation_time > 0.6) or (len(current_text) >= last_word_count + 3)
                        ):
                            last_interim_text = current_text
                            translation = await asyncio.to_thread(
                                self.predict_translation, current_text, False, source_lang, target_lang
                            )

                            await websocket.send_json({
                                "type": "interim",
                                "original": current_text,
                                "translated": translation,
                                "source_lang": source_lang,
                                "target_lang": target_lang
                            })
                            last_word_count = len(current_text)
                            last_translation_time = now

            except WebSocketDisconnect:
                print("[BabelLive] Extension disconnected from Modal session.", flush=True)
            except Exception as e:
                print(f"[BabelLive] WebSocket exception: {e}", flush=True)

        return web_app
