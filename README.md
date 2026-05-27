# 📸 Picture Scout — Local AI Photo Curation & Selection

Picture Scout is a premium, **100% local AI-powered photo curation application** designed to help photographers and hobbyists quickly scout, grade, and curate top picks from their photo folders. 

Powered by **Gemma 4** running locally via **Ollama**, and built with a gorgeous **dark glassmorphism design system** in Vanilla CSS/JS. No data ever leaves your computer, and no paid APIs are required.

---

## ✨ Features

- 📁 **Local Folder Scanning** — Simply enter a path to any local directory on your machine to scan for photos.
- 🧠 **Local AI Curation** — Grades images dynamically from 1 to 10 on four objective criteria: **Composition**, **Lighting**, **Color**, and **Sharpness**.
- 💬 **Constructive Critiques** — Provides one sentence of honest, constructive feedback and automatically tags your photos.
- ⚡ **Batch Processing** — Scan entire folders sequentially with real-time progress bars and Server-Sent Events (SSE).
- 🏷️ **Smart Caching** — Saves results locally in a `.picture-scout-cache.json` in the scanned directory so you never have to pay the computational cost of re-analyzing the same folder.
- 🎛️ **Sort, Search, & Filter** — Filter by minimum score, search by tags/subjects, toggle "Top Picks" (scored 8+), and sort by score, date, or filename.
- ⌨️ **Keyboard Navigation & Detail Drawer** — Arrow keys to navigate, Space/Enter to inspect detailed AI breakdowns, and full-screen image previews.
- 🛠️ **Customizable Settings** — Configure your Ollama model and thumbnail sizes directly from the UI.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism layout, smooth CSS animations), Vanilla JavaScript (no framework overhead).
- **Backend**: Node.js, Express.js.
- **Image Processing**: Sharp (resizes images down to 512px before sending to the model to save VRAM and achieve 4x faster execution).
- **AI Engine**: Ollama (configured to run `gemma4:e4b` locally with a large 2048 context budget to allow full reasoning/thinking cycles).

---

## 🚀 Getting Started

### 1. Prerequisites
- Install [Ollama](https://ollama.com).
- Download Gemma 4 (approx. 8B parameters, Q4 quantization):
  ```bash
  ollama pull gemma4:e4b
  ```
- Make sure Ollama is running (`ollama serve`).

### 2. Installation
Clone the repository, install the dependencies, and start the local development server:
```bash
git clone https://github.com/linhcao1611/picture-scout.git
cd picture-scout
npm install
```

### 3. Running the App
Start the Node.js server:
```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser and start curating!

---

## 🎨 Design Theme
The interface features a highly polished, responsive **dark glassmorphism design** featuring:
- Soft backdrop blur panels (`backdrop-filter: blur(16px)`).
- Vibrant gradient accents (Indigo, Purple, and Cyan).
- Animated scoring bars and interactive gold star rating badges.
- Smooth transitions and interactive micro-animations.
