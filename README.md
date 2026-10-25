# Camera Web Viewer

A web application to stream video and audio from IP cameras (RTSP-compatible cameras) using RTSP to HLS conversion with graceful disconnect handling.

## 📋 About

This project was created for personal use, but is shared here in case it might be useful to someone else. Feel free to modify, improve, and adapt it to your needs. However, **use at your own risk** - this software is provided as-is without any warranties or guarantees.

**Contributions and improvements are welcome!** If you find this useful and make enhancements, consider sharing them back with the community.

## ✨ Features

- **Real-time video and audio streaming** from multiple IP cameras
- **Support for RTSP-compatible cameras** (Tapo, Amcrest, Hikvision, and others)
- **Home grid** - all cameras via **substream** (`previewRtspUrl`); click a tile to watch
- **Watch view** - single camera **main stream**, full viewport
- **Compare live** - select cameras (or all) and view them side by side (substreams)
- **Fullscreen selected** - ephemeral fullscreen mosaic of selected (or all) cameras
- **Live overlays** - Connecting / Reconnecting / No signal + LIVE badge
- **Automatic reconnection** on disconnect with exponential backoff (UI + ffmpeg)
- **RTSP timeout + stall watchdog** - hung streams exit and reconnect
- **HLS streaming** for browser compatibility
- **Dark theme UI** with responsive mosaic layout
- **Configurable per-camera settings** - video/audio modes, decoders, and more
- **Docker Compose** packaging for always-on hosts
- **Flexible configuration** via environment variables

## 🚀 Quick Start

### Prerequisites

- **Node.js 16 or higher** - [Download for Windows](https://nodejs.org/)
- **FFmpeg installed on your system** - Required for RTSP to HLS conversion
- **IP camera with RTSP support**

> **✅ Windows Compatible:** This project works on Windows, macOS, and Linux. All file paths use Node.js cross-platform utilities.

### Installing FFmpeg

**Ubuntu/Debian:**

```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**macOS:**

```bash
brew install ffmpeg
```

**Windows:**

1. Download FFmpeg from [FFmpeg official website](https://ffmpeg.org/download.html) (choose "Windows builds")
2. Extract the ZIP file to a folder (e.g., `C:\ffmpeg`)
3. Add FFmpeg to your system PATH:
   - Press `Win + X` and select "System"
   - Click "Advanced system settings"
   - Click "Environment Variables"
   - Under "System variables", find and select "Path", then click "Edit"
   - Click "New" and add `C:\ffmpeg\bin` (or wherever you extracted FFmpeg)
   - Click "OK" on all dialogs
4. **Restart your terminal/Command Prompt** (important for PATH changes to take effect)
5. Verify installation: Open a new Command Prompt and run `ffmpeg -version`

### Installation

1. Clone or download this repository
2. Install dependencies:

    ```bash
    npm install
    ```

3. Configure your cameras:

    ```bash
    cp .env.example .env
    ```

4. Edit `.env` and set your camera RTSP URLs (see [Configuration](#basic-configuration) below)

5. Start the server:

    ```bash
    npm start
    ```

6. Open your browser to `http://localhost:3000`

### Docker (always-on)

Requires Docker and a configured `.env` (same as above). On Linux, Compose uses **host networking** so RTSP to LAN cameras works without extra routes.

```bash
cp .env.example .env
# edit .env with real camera URLs
docker compose up -d --build
```

Open `http://localhost:3000`. HLS segments persist in `./hls`. Logs: `docker compose logs -f`.

> **Note:** A VS Code Dev Container (`.devcontainer/devcontainer.json`) is optional for development. Runtime packaging is the root `Dockerfile` / `docker-compose.yml`.

## ⚙️ Configuration

### Basic Configuration

Edit the `.env` file to configure your cameras. See `.env.example` for a complete reference.

**Simple RTSP Camera:**

```json
CAMERAS=[
  {
    "id": "camera1",
    "name": "Front Door",
    "rtspUrl": "rtsp://username:password@192.168.1.100:554/stream1",
    "rtspTransport": "tcp",
    "videoMode": "reencode",
    "audioMode": "auto"
  }
]
```

**Hikvision NVR Channel (main + sub):**

```json
CAMERAS=[
  {
    "id": "nvr_ch1",
    "name": "NVR Channel 1",
    "rtspUrl": "rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101",
    "previewRtspUrl": "rtsp://admin:password@192.168.1.100:554/Streaming/Channels/102",
    "rtspTransport": "tcp",
    "videoMode": "reencode",
    "audioMode": "disabled",
    "errorDetection": "ignore_err"
  }
]
```

> **Required:** Disable Hikvision **stream encryption** on the NVR/camera first, or FFmpeg will show gray/green garbage. See [Hikvision: disable stream encryption](#hikvision-disable-stream-encryption).

### Configuration Options

Each camera supports the following options:

**Required:**

- `id` - Unique identifier (e.g., "camera1", "nvr_ch1")
- `name` - Display name (e.g., "Front Door", "NVR Channel 1")
- `rtspUrl` - RTSP stream URL used for **watch** (main / high quality)

**Optional (overrides global defaults):**

- `previewRtspUrl` - Substream for **home**, **compare**, and **fullscreen selected** (e.g. Tapo `/stream2`, Hikvision `…/x02`). If omitted, those views use `rtspUrl`.
- `rtspTransport` - "tcp" or "udp" (default: "tcp")
- `videoMode` - "reencode" or "passthrough" (default: "reencode")
- `audioMode` - "disabled", "auto", or "manual" (default: "auto")
- `audioStreamIndex` - Audio stream index for "manual" mode (default: 0)
- `audioEncodingMode` - "auto" or "force" (default: "auto")
- `videoDecoder` - Explicit decoder ("h264", "hevc") - auto-detects if not set
- `errorDetection` - "ignore_err", "aggressive", "careful", or "compliant" (default: "aggressive")
- `hlsListSize` - Number of HLS segments to keep (default: 10)
- `vsyncMode` - "cfr" (constant) or "vfr" (variable) frame rate (default: "cfr")
- `maxThreads` - Limit CPU threads for encoding (default: auto-detect all cores, set to 2-4 for lower CPU usage)
- `maxFPS` - Limit frame rate (e.g., 15, 20, 25, 30) - reduces CPU usage (default: use source FPS)
- `videoScale` - Scale down resolution (e.g., "1280:720", "1920:1080") - significantly reduces CPU usage (default: no scaling)

### Global Defaults

Set these in `.env` to apply defaults to all cameras:

```bash
DEFAULT_VIDEO_MODE=reencode
DEFAULT_AUDIO_MODE=auto
DEFAULT_AUDIO_STREAM_INDEX=0
DEFAULT_AUDIO_ENCODING_MODE=auto
VIDEO_BITRATE=2048k
VIDEO_BUFSIZE=4M
DEFAULT_ERROR_DETECTION=aggressive
VIDEO_PRESET=veryfast
MAX_THREADS=4
MAX_FPS=20
VIDEO_SCALE=1280:720
RTSP_TIMEOUT_US=15000000
STALL_TIMEOUT_SEC=30
```

**~10 cameras:** Prefer `videoMode: "passthrough"` when cameras already output H.264. Otherwise reencode with per-camera `maxFPS` / `videoScale` / `maxThreads`. Use `VIDEO_PRESET=ultrafast` if the host is CPU-bound.

**CPU Limiting Options (to reduce CPU usage):**

- `VIDEO_PRESET` - Encoding preset: `ultrafast` (lowest CPU, lower quality), `superfast`, `veryfast` (default), `faster`, `fast`, `medium`, `slow`, `slower`, `veryslow` (highest CPU, best quality)
- `MAX_THREADS` - Limit CPU threads (e.g., `2`, `4`, `6`) - prevents using all CPU cores (default: auto-detect all cores)
- `MAX_FPS` - Limit frame rate (e.g., `15`, `20`, `25`, `30`) - reduces CPU usage (default: use source FPS)
- `VIDEO_SCALE` - Scale down resolution (e.g., `1280:720`, `1920:1080`) - significantly reduces CPU usage (default: no scaling)
- `VIDEO_BITRATE` - Reduce bitrate (e.g., `1024k`, `1536k`) - lower values use less CPU (default: `2048k`)
- `RTSP_TIMEOUT_US` - RTSP socket timeout in microseconds (default: `15000000` = 15s)
- `STALL_TIMEOUT_SEC` - Restart ffmpeg if HLS output stalls (default: `30`)

## 📹 Getting Your Camera RTSP URL

### Tapo Cameras

1. Open the Tapo app on your phone
2. Go to your camera's settings
3. Navigate to **Advanced Settings** > **Camera Account**
4. Create a username and password for RTSP access
5. Find your camera's local IP address (usually in network settings)
6. Use the format: `rtsp://username:password@camera_ip:554/stream1`
   - Use `/stream1` for high quality (`rtspUrl` / watch)
   - Use `/stream2` for lower quality (`previewRtspUrl` / home, compare, fullscreen selected)
   - Port is typically `554` (standard RTSP) or `2020` (ONVIF management port)

**Note:** This application supports many RTSP-compatible cameras, not just Tapo.

### Amcrest Cameras

1. Log into your camera's web interface (usually `http://camera_ip`)
2. Go to **Settings** > **Network** > **RTSP**
3. Enable RTSP and note the username and password
4. Use one of these formats:
   - `rtsp://username:password@camera_ip:554/cam/realmonitor?channel=1&subtype=0`
   - `rtsp://username:password@camera_ip:554/Streaming/Channels/101`
   - Check your camera's documentation for the exact format for your model

### Hikvision NVR

1. Log into your NVR's web interface (usually `http://nvr_ip:8081` or similar)
2. **Disable stream encryption** (required — see below)
3. Note username/password (prefer a dedicated RTSP user with live-view rights)
4. Channel URLs: `rtsp://user:pass@nvr_ip:554/Streaming/Channels/[channel]0[stream]`
   - Channel 1: `101` main / `102` sub  
   - Channel 2: `201` main / `202` sub  
   - … (`x01` = main for watch, `x02` = sub for home/compare/fullscreen)
5. **Alternative paths** (some models):
   - `rtsp://…/h264/ch[channel]/main/av_stream`
   - `rtsp://…/h264/ch[channel]/sub/av_stream`

**Configuration options:**

- `rtspTransport: "tcp"` - Recommended for Hikvision NVRs
- `videoMode: "reencode"` - Required for reliable browser HLS
- `videoDecoder: "hevc"` - Only if that channel’s **main** stream is H.265 (omit for H.264)
- `errorDetection: "ignore_err"` - Often better for analog/hybrid NVR noise than `aggressive`
- `audioMode: "disabled"` - Common for NVR channels without usable audio

#### Hikvision: disable stream encryption

Many Hikvision NVRs/cameras enable **stream encryption** (verification code / “encrypt video”). Encrypted RTSP **cannot** be decoded by FFmpeg or this viewer: you get a gray/green picture or constant decode errors even when the URL and password are correct. iVMS / Hik-Connect can still play the stream because they know the verification code — this app cannot use that PIN.

**Turn encryption off** before using this viewer:

1. Prefer the **NVR local monitor** (HDMI + mouse): **Menu → Configuration → Network → Platform Access** (or Hik-Connect) → untick **Enable Stream Encryption** → Apply.
2. Or web UI / Hik-Connect app (firmware-dependent): Platform Access / site settings → disable **Image and Video encryption** / stream encryption.
3. Retest:  
   `ffmpeg -rtsp_transport tcp -i "rtsp://USER:PASS@NVR:554/Streaming/Channels/101" -frames:v 1 -f null -`  
   You should get a real frame, not gray noise.

Encryption is a **device setting**. This project cannot unlock encrypted streams. If encryption must stay on, use Hikvision’s own clients.

## 🎯 Usage

Start the server:

```bash
npm start
```

The server will:

- Start on `http://localhost:3000` (or the port specified in `.env`)
- Automatically begin streaming from all configured cameras (main + preview when set)
- Serve the home grid (substreams) at `/`

### View Modes

| View | How | Stream |
|------|-----|--------|
| **Home** | Default landing | Substream (`previewRtspUrl`) |
| **Watch** | Click a home tile | Main (`rtspUrl`) |
| **Compare live** | Tick ≥2 cameras (or none = all) → **Compare live** | Substreams |
| **Fullscreen selected** | Tick cameras (or none = all) → **Fullscreen selected** | Substreams |

Selection rules: **0 ticked** = treat as all cameras; **Compare** needs at least 2; **Fullscreen selected** needs at least 1.

## 🔧 API Endpoints

- `GET /api/cameras` - Camera list with `isStreaming` / `previewStreaming` / `hasPreview`
- `GET /api/health` - Basic health (legacy single-stream summary)
- `GET /api/stream/status?cameraId=` - Stream status (omit `cameraId` for all)
- `GET /api/stream/:cameraId/playlist.m3u8` - Main HLS playlist (watch)
- `GET /api/stream/:cameraId/preview.m3u8` - Substream HLS (home/compare/FS); falls back to main
- `POST /api/stream/start` - Body `{ "cameraId": "…" }` (optional; omit for first camera)
- `POST /api/stream/stop` - Body `{ "cameraId": "…" }`

## 📷 Camera Model Compatibility

**Note:** This application works with any RTSP-compatible camera, not just specific brands.

**Tapo Cameras (Compatible):**

- C100, C200, C310, C320WS, C500, and most other wired Tapo cameras
- RTSP URL format: `rtsp://username:password@ip:554/stream1`

**Tapo Cameras (Not Compatible):**

- Most battery-powered models (C410, C420, C425, D230)
- Exceptions: D235, D225, TD25 (only when hardwired and in "always-on mode")

**Amcrest Cameras:**

- Most Amcrest IP cameras with RTSP support
- RTSP URL format: `rtsp://username:password@ip:554/cam/realmonitor?channel=1&subtype=0`

**Hikvision NVR:**

- Works with all Hikvision NVR models (DS-7600, DS-7700, DS-7800, DS-7900 series, etc.)
- **Audio Note**: Some Hikvision NVR channels don't have audio or produce noise. Use `"audioMode": "disabled"` to disable audio for these cameras

**Other ONVIF-Compatible Cameras:**

- Any camera that supports RTSP streaming should work
- You'll need to find the correct RTSP URL format for your camera model

## 🐛 Troubleshooting

### Stream not connecting

1. Verify your RTSP URL is correct
2. Ensure the camera and server are on the same network
3. Check that FFmpeg is installed: `ffmpeg -version`
4. Check server logs for error messages
5. Verify the camera account credentials are correct
6. Try different RTSP transport (TCP vs UDP)

### Video not playing in browser

1. Check browser console for errors
2. Verify HLS segments are being generated in the `hls/` directory
3. Try refreshing the page
4. Check that Video.js library is loading correctly
5. Verify the stream is actually running (check server logs)

### High CPU usage

- **Set `VIDEO_PRESET=ultrafast`** in `.env` - fastest encoding (lowest CPU, acceptable quality)
- **Set `MAX_THREADS=2` or `MAX_THREADS=4`** - limit CPU cores used (prevents maxing out all cores)
- **Set `MAX_FPS=15` or `MAX_FPS=20`** - limit frame rate (reduces CPU significantly)
- **Set `VIDEO_SCALE=1280:720`** - scale down resolution (major CPU reduction)
- **Reduce `VIDEO_BITRATE=1024k`** - lower bitrate uses less CPU
- **Use `videoMode: "passthrough"`** per camera - if camera outputs H.264, this avoids re-encoding (saves most CPU)
- Use sub-stream instead of main stream for lower quality
- Reduce number of simultaneous streams

### Gray or green video

- **Hikvision:** disable **stream encryption** on the NVR ([section above](#hikvision-disable-stream-encryption)) — the most common cause of gray RTSP with a working iVMS/Hik-Connect PIN
- Prefer `videoMode: "reencode"` over passthrough for NVR channels
- Do **not** force `videoDecoder: "hevc"` on H.264 streams (and vice versa)
- Confirm main vs sub URLs (`…101` vs `…102`)

### Corrupted video or decoding errors

- For hybrid NVRs try `errorDetection: "ignore_err"`
- Only set `videoDecoder` when you know the codec (H.264 vs H.265)
- Prefer `rtspTransport: "tcp"`
- Check network stability and packet loss

## 🏗️ Architecture

- **Backend**: Node.js + Express + FFmpeg (RTSP → HLS; main + optional preview ingest)
- **Frontend**: Vanilla HTML/CSS/JS + Video.js (home, watch, compare live, fullscreen selected)
- **Streaming**: HLS for browser compatibility
- **Resilience**: Per-camera ffmpeg reconnect, RTSP timeout, HLS stall watchdog; UI exponential retry
- **Configuration**: Environment variables via `.env` file
- **Deploy**: Optional Docker Compose (`network_mode: host` on Linux)

## 📝 License

This project is provided **free of charge** and **as-is** for anyone who might find it useful.

**Use at your own risk** - no warranties or guarantees are provided.

You are free to:

- ✅ Use this software for any purpose
- ✅ Modify and adapt it to your needs
- ✅ Share it with others
- ✅ Improve it and contribute back

## 🤝 Contributing

Contributions, improvements, and bug fixes are welcome! If you find this useful and make enhancements, consider sharing them back with the community.

## ⚠️ Disclaimer

This software is provided **as-is** without any warranties or guarantees. The author(s) are not responsible for any damage, data loss, or issues that may arise from using this software. **Use at your own risk.**

## 📚 Additional Resources

- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [Video.js Documentation](https://videojs.com/getting-started/)
- [HLS Streaming Guide](https://developer.apple.com/streaming/)
- [RTSP Protocol Specification](https://tools.ietf.org/html/rfc2326)

---

**Created for personal use, but shared in case it might be useful to someone. Feel free to modify, improve, and share!**
