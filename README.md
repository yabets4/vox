# VOX — Hear Every Page 📖🔊

> **100% On-device neural voice reader for your PDFs and documents.**  
> Powered by **Kokoro-82M** & **KittenTTS**, built with **React**, **Vite**, and **Capacitor**. Zero cloud APIs, zero subscriptions, complete privacy.

[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20Web-blue.svg)](https://github.com/yabets4/vox)
[![License](https://img.shields.io/badge/License-Apache%202.0%20%2F%20MIT-green.svg)](https://github.com/yabets4/vox)
[![TTS Engine](https://img.shields.io/badge/TTS-Kokoro--82M%20%7C%20KittenTTS-orange.svg)](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
[![Prebuilt APK](https://img.shields.io/badge/Download-VOX.apk%20(12.5%20MB)-success.svg)](VOX.apk)

---

## 🌟 Highlights

- **🧠 100% On-Device Neural Synthesis**: No voice data or documents ever leave your device. All speech synthesis is computed locally via WebGPU or WASM.
- **⚡ Three Hardware-Calibrated Tiers**:
  - **Studio** (`Kokoro-82M fp32`, WebGPU, ~326 MB): State-of-the-art studio voice synthesis running on your graphics processor.
  - **Standard** (`Kokoro-82M q8`, WASM CPU, ~92 MB): High-quality 8-bit quantized Kokoro model running on any standard CPU.
  - **Lite** (`KittenTTS nano fp32`, WASM CPU, ~60 MB): Ultra-compact and speedy synthesis for older or resource-constrained devices (optimized fp32 build runs ~1.7× faster on WASM).
- **📄 Smart Document Pipeline**:
  - Intelligent PDF text extraction powered by `pdfjs-dist`.
  - Automatic removal of repeated running headers, footers, and page numbers.
  - Re-flow and hyphenation restoration across line wraps and page boundaries for fluid, uninterrupted reading.
- **🎧 Seamless Streaming & Multi-Lane Buffering**:
  - **Dedicated Worker Pool**: Synthesis runs completely off the main UI thread via `tts.worker.js`, dynamically scaling from 1 to 6 parallel worker lanes based on device RAM and CPU cores.
  - **Cross-Origin Isolation on Android**: Native headers inject COOP/COEP in `MainActivity.java`, unlocking `SharedArrayBuffer` for true multithreaded WASM execution.
  - Intelligent lookahead synthesis buffer (up to 45 minutes ahead, pruned behind playhead).
  - Adaptive runtime speed learning (tracks real-time factor `RTF` and seconds-per-character `SPC` per device tier).
  - Background playback, mini-player controls, modal-aware back-button handling, and sleep-safe audio scheduling.
- **💾 Fail-Proof Persistent Offline Storage**:
  - Custom chunked file storage on Android via Capacitor Filesystem (bypasses browser Cache API 100MB limits).
  - IndexedDB Blob caching with persistent storage requests in desktop browsers.
  - Granular storage inspector to monitor model sizes, saved books, and synthesized audio chunks.
- **📱 Ready-to-Install Android App**: Pre-built [`VOX.apk`](VOX.apk) (12.5 MB) included for immediate sideloading.

---

## 🚀 Quick Start

### Android (Download & Install APK)
Grab the prebuilt APK directly from the repository root:
1. Download [**`VOX.apk`**](VOX.apk) (or from GitHub Releases).
2. Sideload onto your Android phone (Android 8.0+ recommended).
3. On first launch, pick your preferred engine tier (or let VOX auto-detect your hardware).
4. Import any PDF and start listening!

---

### Web / Local Development

#### Prerequisites
- **Node.js** (v18 or higher recommended)
- **npm** or **pnpm**

#### Setup & Run
```bash
# Clone the repository
git clone https://github.com/yabets4/vox.git
cd vox/vox

# Install dependencies
npm install

# Start local development server
npm run dev
```

Visit `http://localhost:5173` (or the URL shown in your terminal).

#### Build for Web
```bash
npm run build
npm run preview
```

---

### Android Build (Capacitor)

#### Prerequisites
- **Android Studio** & Android SDK (API 34+)
- **Java 17+**

#### Sync & Build Android App
```bash
cd vox/vox

# Build web assets and sync to native Android container
npm run build
npx cap sync android

# Open in Android Studio
npm run cap:open

# Or build the debug APK directly via Gradle
cd android
./gradlew assembleDebug
```
The compiled APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## 🏗️ Architecture & How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      PDF Input File                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Smart Extraction (pdf.js)                   │
│   • Y-band grouping & X-gap character joining               │
│   • Header / Footer / Page number statistical stripping     │
│   • Hyphen re-stitching & continuous paragraph reflow       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Sentence & Thought Chunking (tts.js)            │
│   • Natural pauses, commas, semicolons, sentence limits     │
│   • Dynamic lookahead synthesis queue                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Hardware-Calibrated Engine                  │
│                                                             │
│   [Studio Tier]         [Standard Tier]       [Lite Tier]   │
│   Kokoro-82M (fp32)     Kokoro-82M (q8)       KittenTTS     │
│   WebGPU Acceleration   WASM Multithreaded    WASM (fp32)   │
│   ~326 MB               ~92 MB                ~60 MB        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Custom Model & Audio Cache Layer               │
│   • Android: 3 MB chunked native filesystem writes          │
│   • Web: IndexedDB Blobs + navigator.storage.persist()      │
│   • Audio Cache: Per-sentence chunk reuse & WAV export      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Player UI & Background Playback                 │
│   • Word/Sentence tracking • Mini-player • Speed 0.75-2.0x  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎙️ Available Voices

### Kokoro Engine (Studio & Standard Tiers)
| Voice ID | Gender | Accent | Quality Rating |
| :--- | :--- | :--- | :--- |
| **`af_heart`** *(Default)* | Female | US English | Grade A |
| **`af_bella`** | Female | US English | Grade A- |
| **`af_nicole`** | Female | US English | Grade B- |
| **`bf_emma`** | Female | UK English | Grade B- |
| **`am_michael`** | Male | US English | Grade C+ |
| **`am_fenrir`** | Male | US English | Grade C+ |
| **`am_puck`** | Male | US English | Grade C+ |
| **`bm_fable`** | Male | UK English | Grade C |
| **`bm_george`** | Male | UK English | Grade C |

### KittenTTS Engine (Lite Tier)
- **Female**: Bella, Luna, Rosie, Kiki
- **Male**: Leo, Jasper, Bruno, Hugo

---

## 📂 Project Structure

```text
transcribe/
├── VOX.apk                      # Ready-to-install Android release APK (12.5 MB)
├── icon-preview.html            # Visual preview and icon design showcase
├── README.md                    # Project documentation
├── .gitignore                   # Root ignore rules for node_modules, builds, & Gradle
└── vox/                         # VOX application source
    ├── capacitor.config.json    # Capacitor native app configuration
    ├── index.html               # Main entry HTML
    ├── package.json             # NPM package specification & dependencies
    ├── vite.config.js           # Vite bundler configuration
    ├── public/
    │   └── icons/               # High-resolution application icons & designs
    ├── src/
    │   ├── App.jsx              # Main application shell, playback state & buffer loop
    │   ├── main.jsx             # React DOM root initialization
    │   ├── styles.css           # Custom warm editorial design system
    │   ├── components/
    │   │   └── ui.jsx           # TabBar, MiniPlayer, Toast, and shared primitives
    │   ├── lib/
    │   │   ├── kitten/          # Embedded KittenTTS nano engine & phonemizers
    │   │   ├── library.js       # IndexedDB storage for books, chunks, & metadata
    │   │   ├── modelCache.js    # Resilient chunked caching for ONNX weights
    │   │   ├── pdf.js           # Layout-aware PDF parser, stripper & text reflower
    │   │   ├── save.js          # Audio file persistence & WAV export helpers
    │   │   ├── tts.js           # Multi-tier voice synthesizer, worker pool & device profiler
    │   │   └── tts.worker.js    # Dedicated background worker for zero-jank neural inference
    │   └── pages/
    │       ├── Library.jsx      # Document shelf, import progress, & book management
    │       ├── Player.jsx       # Audio playback, speed, scrub, and reading view
    │       ├── Settings.jsx     # Voice selection, tier switcher & hardware diagnostics
    │       └── Storage.jsx      # Cache inspector & disk space management
    └── android/                 # Android Studio project with Capacitor bridge
```

---

## 🛠️ Tech Stack

- **Frontend**: [React 18](https://react.dev/), [Vite](https://vitejs.dev/)
- **Mobile Container**: [Capacitor 6](https://capacitorjs.com/) (Filesystem, Share, Android Bridge)
- **Neural TTS**:
  - [Kokoro-JS](https://github.com/hexgrad/kokoro) & [Kokoro-82M ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
  - [Hugging Face Transformers.js v3](https://github.com/huggingface/transformers.js) (WebGPU & ONNX Runtime Web)
  - [KittenTTS Nano](https://github.com/KittenTTS)
- **Document Processing**: [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`)
- **Storage**: IndexedDB (documents, audio chunks) + Android Native Filesystem (model weights)

---

## 🔒 Privacy & Offline Guarantee

VOX was created with a zero-compromise privacy design:
- **No telemetry, trackers, or analytics**.
- **No external API calls for synthesis**: once a voice model is cached, VOX functions completely in airplane mode.
- **Your documents stay yours**: PDFs are processed in browser memory and stored exclusively in your local device's IndexedDB.

---

## 📄 License

This project is licensed under the Apache License 2.0 / MIT.  
- Kokoro weights are released under Apache 2.0.
- KittenTTS is released under Apache 2.0.
