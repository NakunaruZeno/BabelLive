# BabelLive

[English](README.md) | [Tiếng Việt](README.vi.md) | [日本語](README.ja.md)

YouTubeライブ配信および動画向けリアルタイムAIバイリンガル字幕拡張機能。

BabelLiveはブラウザタブの音声を直接キャプチャし、低遅延で音声認識および文脈考慮翻訳を実行して、HTML5動画プレーヤー上に高視認性の2言語字幕を直接オーバーレイ表示します。

---

## システム構成

BabelLiveは、ライブストリーミング処理に最適化された疎結合クライアント・サーバーモデルを採用しています。

```text
ブラウザタブ (YouTube)
  │
  ├─► chrome.tabCapture (音声ストリーム)
  │     │
  │     ▼
  │   Offscreen Document (AudioContext / ScriptProcessor)
  │     │ (16kHz Int16 PCM Direct Streaming)
  │     ▼
  │   WebSocket接続 (wss://)
  │     │
  │     ▼
  │   AIバックエンド (FastAPI / Colab T4 GPU)
  │     ├─► AudioStreamDecoder & RMSエネルギーVAD
  │     ├─► Kotoba-Whisper v2.0 (日本語音声認識)
  │     └─► Qwen2.5-3B-Instruct (文脈考慮翻訳)
  │     │
  │     ▼
  │   WebSocket JSONメッセージ (予測中間字幕 & 確定字幕)
  │     │
  │     ▼
  └─◄ Content Script (DOMオーバーレイ & 動画プレーヤーフック)
```

1. **タブ音声キャプチャ:** Chrome Manifest V3のOffscreen Document内で`chrome.tabCapture`を使用し、ユーザーのリスニング音声を遮断することなくタブ音声を内部取得します。
2. **直接PCMストリーミング:** 音声を16kHz Int16モノラルPCMに変換し、WebSocket接続を通じて生の音声チャンクを直接送信します。
3. **高精度音声認識 (ASR):** 日本語に特化した`kotoba-tech/kotoba-whisper-v2.0`（ReazonSpeech 700万件の音声で学習、CER約8.4%、元祖Whisper large-v3比6.3倍高速）を採用。
4. **文脈考慮型翻訳 (LLM):** `Qwen/Qwen2.5-3B-Instruct`を使用し、口語表現、敬語、配信特有のニュアンスを自然に翻訳します。
5. **DOM字幕オーバーレイ:** アニメスタイル・シネマスタイルの字幕コンテナをYouTubeプレーヤー内に直接描画し、ドラッグ移動、フォントサイズ変更、自動フェードアウトに対応します。

---

## 主な機能

- **リアルタイムストリーミング認識:** WebSocket通信により、発話中の予測中間結果（Interim）と文確定結果（Final）の両方をシームレスに更新。
- **音声区間検出 (VAD) と幻覚抑制:** RMSエネルギー閾値判定と重複トークン制御により、BGMや無音区間におけるWhisperの反復出力を効果的に遮断。
- **Google Driveによる永続キャッシュ:** pipホイールおよびHugging Faceモデル重みをGoogle Drive（`/content/drive/MyDrive/BabelLive_Cache/`）にキャッシュし、次回以降のダウンロード時間を完全に排除。
- **Colab自動実行:** 1クリックでColabノートブックを開き、セル実行（Ctrl+F9）と警告ダイアログの承認、WebSocket URLの自動取得を完結。
- **多彩なスタイル設定:** Anime、Cinema、Minimalのプリセットを提供し、ピン留めや字幕コピー機能も搭載。
- **バイリンガル表示:** 原文音声の文字起こしと翻訳テキストを同時に並行表示。

---

## ディレクトリ構成

```text
BabelLive/
├── colab/                      # Google Colab GPUバックエンド
│   ├── BabelLive_Backend.ipynb # 公式ノートブック (Kotoba-Whisper + Qwen2.5 + WebSocket)
│   └── README.md               # バックエンド環境構築ガイド
│
├── src/                        # Chrome拡張機能 (Manifest V3)
│   ├── manifest.json           # 拡張機能構成ファイルおよび権限設定
│   ├── popup.html / popup.css  # ポップアップ管理UI
│   ├── popup.js                # 状態管理およびメッセージング
│   ├── content.js              # 動画プレーヤーフックおよび字幕オーバーレイ
│   ├── overlay.css             # 字幕スタイルおよびアニメーション定義
│   ├── offscreen.html / .js    # タブ音声取得および16kHz PCM送信
│   ├── service-worker.js       # バックグラウンドメッセージルーター
│   ├── colab-automator.js      # Colab自動操作スクリプト
    └── translation/            # 翻訳ルーターおよびフォールバックモジュール
        ├── cloud-llm.js        # クラウドLLM翻訳アダプタ (Groq / Gemini)
        ├── stream-buffer.js    # 文境界判定プロセッサ
        └── translation-router.js
```

---

## インストールと利用手順

### 1. Chrome拡張機能の読み込み

1. 本リポジトリをクローンまたはダウンロードします。
   ```bash
   git clone https://github.com/NakunaruZeno/BabelLive.git
   ```
2. Google Chromeを開き、`chrome://extensions/` にアクセスします。
3. 右上の **デベロッパーモード** を有効にします。
4. **パッケージ化されていない拡張機能を読み込む** をクリックし、`src/` フォルダを選択します。

### 2. Google Colabバックエンドの起動

1. [Google Colab](https://colab.research.google.com/) を開き、`colab/BabelLive_Backend.ipynb` をアップロードします。
2. メニューの **ファイル** -> **ドライブにコピーを保存** を選択します。
3. **ランタイム** -> **ランタイムのタイプを変更** で **T4 GPU** を選択して保存します。
4. 左サイドバーの **シークレット**（鍵アイコン）で `NGROK_AUTHTOKEN` を追加し、ノートブックからのアクセスを許可します。
5. BabelLiveポップアップにて:
   - コピーしたColabのGoogle Driveリンクを **Colab Notebook URL** に貼り付け、**Launch & Start Subtitles** をクリックするか、
   - 手動でノートブックを実行（Ctrl+F9）し、出力された `wss://.../ws/live` URLを **Colab WebSocket URL** に入力してトグルを有効化します。

---

## 使用技術

- **拡張機能:** Chrome Extensions API (Manifest V3), Web Audio API, DOM MutationObserver.
- **バックエンド:** Python 3.10+, FastAPI, Uvicorn, WebSockets, PyNgrok.
- **音声認識:** Hugging Face Transformers, `kotoba-tech/kotoba-whisper-v2.0`, PyTorch.
- **機械翻訳:** `Qwen/Qwen2.5-3B-Instruct`, Accelerate.

---

## セキュリティとプライバシー

- `chrome.tabCapture` で取得された音声データは、ユーザー自身のColabインスタンスにのみ暗号化通信で送信されます。
- 設定情報およびAPIキーはすべてローカルストレージ（`chrome.storage.local`）にのみ保存されます。
- 第三者への音声データ蓄積や共有は一切行われません。

---

## ライセンス

本プロジェクトはMITライセンスの下で公開されています。詳細は [LICENSE](LICENSE) を参照してください。
