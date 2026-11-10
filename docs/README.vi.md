# BabelLive

[English](../README.md) | [Tiếng Việt](README.vi.md) | [日本語](README.ja.md)

Tiện ích mở rộng tạo phụ đề song ngữ AI theo thời gian thực cho video và luồng phát trực tiếp trên YouTube.

BabelLive thu nhận âm thanh từ thẻ trình duyệt, thực hiện nhận dạng giọng nói và dịch thuật ngữ cảnh với độ trễ thấp, sau đó hiển thị phụ đề song ngữ trực tiếp trên trình phát video HTML5 của YouTube.

---

## Kiến Trúc Hệ Thống

BabelLive hoạt động theo mô hình client-server phân tách, tối ưu hóa cho tác vụ xử lý phương tiện truyền thông trực tiếp:

```text
Thẻ trình duyệt (YouTube)
  │
  ├─► chrome.tabCapture (Luồng âm thanh)
  │     │
  │     ▼
  │   Offscreen Document (AudioContext / AudioWorklet 16kHz PCM)
  │     │ (Dữ liệu PCM 16kHz Int16 trực tiếp — khung 128ms)
  │     ▼
  │   Kênh WebSocket (wss://)
  │     │
  │     ▼
  │   Backend AI (FastAPI / Modal Serverless T4 hoặc Colab T4 GPU)
  │     ├─► Gom gói WebSocket & Bộ lọc năng lượng RMS VAD
  │     ├─► Kotoba-Whisper v2.0 (Nhận dạng tiếng nói)
  │     └─► Qwen2.5-7B-Instruct 4-bit NF4 (Dịch ngữ cảnh)
  │     │
  │     ▼
  │   Thông điệp JSON WebSocket (Phụ đề dự đoán & phụ đề hoàn tất)
  │     │
  │     ▼
  └─◄ Content Script (Overlay DOM & Móc nối trình phát video)
```

1. **Thu âm thẻ trình duyệt:** Sử dụng `chrome.tabCapture` trong môi trường offscreen document (Manifest V3) mà không làm ngắt âm thanh nghe của người dùng.
2. **Truyền luồng PCM qua AudioWorklet:** Chuyển đổi tần số lấy mẫu về 16kHz Int16 đơn kênh theo khung 128ms trên luồng âm thanh riêng biệt và truyền qua WebSocket có kiểm soát nghẽn mạng.
3. **Nhận dạng giọng nói (ASR):** Sử dụng mô hình `kotoba-tech/kotoba-whisper-v2.0` (huấn luyện trên 7 triệu mẫu âm thanh ReazonSpeech, CER ~8.4%, nhanh gấp 6.3 lần so với bản Whisper large-v3 gốc).
4. **Dịch thuật ngữ cảnh (LLM):** Sử dụng `Qwen/Qwen2.5-7B-Instruct` (4-bit NF4 qua BitsAndBytes) kết hợp bộ nhớ ngữ cảnh hội thoại liền trước, bảo toàn văn phong tự nhiên và thuật ngữ VTuber/anime.
5. **Hiển thị phụ đề trên DOM:** Khung hiển thị phụ đề (`Anime`, `Cinema`, `Minimal`) hỗ trợ khóa vị trí, kéo thả theo tỷ lệ khung hình, phím tắt `Alt+B` bật/tắt song ngữ ngay trong chế độ toàn màn hình.

---

## Các Tính Năng Chính

- **Xử lý thời gian thực dạng luồng:** Kiến trúc WebSocket truyền tải cả kết quả dự đoán tạm thời (interim) và câu hoàn chỉnh (final).
- **Phát hiện tiếng nói (VAD) và triệt tiêu lặp từ:** Sử dụng ngưỡng năng lượng RMS kết hợp thuật toán kiểm tra chuỗi để loại bỏ hiện tượng sinh từ thừa trong các đoạn nhạc nền hoặc khoảng lặng.
- **Bộ nhớ đệm vĩnh viễn trên Google Drive:** Lưu trữ các gói thư viện pip và trọng số mô hình vào Google Drive (`/content/drive/MyDrive/BabelLive_Cache/`), loại bỏ việc tải lại dữ liệu trong các phiên làm việc tiếp theo.
- **Tự động hóa khởi chạy Colab:** Script nền hỗ trợ kích hoạt chạy notebook, xác nhận cảnh báo của Colab và tự động nhận dạng địa chỉ WebSocket chỉ với một thao tác.
- **Tùy chỉnh hiển thị đa dạng:** Cung cấp các cấu hình Anime, Cinema và Minimal cùng thanh công cụ hỗ trợ ghim vị trí và sao chép nội dung phụ đề.
- **Hiển thị song ngữ:** Hỗ trợ hiển thị đồng thời cả câu gốc và câu dịch.

---

## Cấu Trúc Thư Mục

```text
BabelLive/
├── backend/                       # Các giải pháp AI Backend
│   ├── colab/                     # Môi trường chạy trên Google Colab GPU
│   │   ├── BabelLive_Backend.ipynb# Notebook (Kotoba-Whisper + Qwen2.5 + WebSocket)
│   │   └── README.md              # Hướng dẫn chi tiết chạy Colab T4 miễn phí
│   └── modal/                     # Môi trường Serverless GPU trên Modal Labs
│       ├── app.py                 # Máy chủ ASGI WebSocket khởi động tức thì
│       ├── requirements.txt       # Thư viện triển khai Modal CLI
│       └── README.md              # Hướng dẫn triển khai Modal Cloud
│
├── docs/                          # Tài liệu đa ngôn ngữ
│   ├── README.vi.md               # Bản dịch tiếng Việt
│   └── README.ja.md               # Bản dịch tiếng Nhật
│
├── src/                           # Tiện ích mở rộng Chrome (Manifest V3)
│   ├── background/
│   │   └── service-worker.js      # Định tuyến thông điệp và quản lý vòng đời phiên
│   ├── content/
│   │   ├── content.js             # Móc nối trình phát video, hiển thị phụ đề & phím tắt
│   │   ├── overlay.css            # Định kiểu phụ đề (Anime, Cinema, Minimal)
│   │   └── colab-automator.js     # Script tự động kích hoạt Colab 1 chạm
│   ├── popup/
│   │   ├── popup.html             # Giao diện điều khiển Minimalist Studio
│   │   ├── popup.css              # Giao diện tối hiện đại, viền hairline tinh tế
│   │   └── popup.js               # Quản lý cấu hình & kết nối WebSocket
│   ├── offscreen/
│   │   ├── offscreen.html         # Trang thu âm nền offscreen
│   │   ├── offscreen.js           # AudioContext, loopback tai nghe & gửi luồng WebSocket
│   │   └── audio-worklet-processor.js # Thu nhận PCM 16kHz Int16 độ trễ 128ms
│   ├── icons/                     # Bộ icon SVG & PNG trong suốt
│   │   ├── icon.svg
│   │   └── icon*.png
│   └── manifest.json              # Bản khai Manifest V3 của tiện ích
│
├── .gitignore                     # Cấu hình bỏ qua tệp nhị phân & rác
├── LICENSE                        # Giấy phép mã nguồn mở MIT
└── README.md                      # Tài liệu tiếng Anh chính của dự án
```

---

## Hướng Dẫn Cài Đặt & Sử Dụng

### 1. Cài đặt tiện ích vào Chrome

1. Tải về mã nguồn dự án:
   ```bash
   git clone https://github.com/NakunaruZeno/BabelLive.git
   ```
2. Mở trình duyệt Google Chrome và truy cập `chrome://extensions/`.
3. Bật **Chế độ dành cho nhà phát triển** (Developer mode) ở góc phải màn hình.
4. Chọn **Tải tiện ích đã giải nén** (Load unpacked) và chọn thư mục `src/`.

### 2. Khởi động AI Backend trên Google Colab

1. Truy cập [Google Colab](https://colab.research.google.com/) và tải lên tệp `backend/colab/BabelLive_Backend.ipynb`.
2. Lưu bản sao vào Drive cá nhân qua **Tệp** -> **Lưu bản sao trong Drive**.
3. Chọn loại phần cứng **T4 GPU** trong menu **Thời gian chạy** -> **Thay đổi loại thời gian chạy**.
4. Cấu hình khóa bí mật `NGROK_AUTHTOKEN` trong mục **Secrets** (biểu tượng Chìa khóa) và bật quyền truy cập cho notebook.
5. Trên giao diện popup của tiện ích BabelLive:
   - Dán đường dẫn Drive của Colab vào ô **Colab Notebook URL** và bấm **Launch & Start Subtitles**, hoặc
   - Chạy thủ công notebook (Ctrl+F9), sao chép địa chỉ `wss://.../ws/live` xuất hiện ở Cell 4, dán vào ô **Colab WebSocket URL** và bật công tắc hoạt động.

---

## Công Nghệ Sử Dụng

- **Tiện ích mở rộng:** Chrome Extensions API (Manifest V3), Web Audio API (`AudioWorkletNode`), DOM `MutationObserver`.
- **Dịch vụ Backend:** Python 3.10+, FastAPI, Uvicorn, WebSockets, Modal Labs Serverless GPU / PyNgrok.
- **Nhận dạng tiếng nói:** Hugging Face Transformers, `kotoba-tech/kotoba-whisper-v2.0`, PyTorch.
- **Dịch thuật:** `Qwen/Qwen2.5-7B-Instruct` (4-bit NF4), BitsAndBytes, Accelerate.

---

## Bảo Mật & Quyền Riêng Tư

- Luồng âm thanh thu nhận qua `chrome.tabCapture` được truyền trực tiếp đến phiên làm việc Colab cá nhân của bạn.
- Toàn bộ thông tin cấu hình và khóa bí mật được lưu trữ cục bộ trong `chrome.storage.local`.
- Không có bất kỳ dữ liệu âm thanh hoặc văn bản nào được lưu trữ hay chia sẻ với bên thứ ba.

---

## Giấy Phép

Dự án được phân phối theo giấy phép MIT. Xem chi tiết tại tệp [LICENSE](LICENSE).
