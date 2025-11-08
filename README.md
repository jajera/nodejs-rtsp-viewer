# Camera Web Viewer

A web application to stream video and audio from IP cameras (RTSP-compatible cameras) using RTSP to HLS conversion with graceful disconnect handling.

## 📋 About

This project was created for personal use, but is shared here in case it might be useful to someone else. Feel free to modify, improve, and adapt it to your needs. However, **use at your own risk** - this software is provided as-is without any warranties or guarantees.

**Contributions and improvements are welcome!** If you find this useful and make enhancements, consider sharing them back with the community.

## ✨ Features

- **Real-time video and audio streaming** from multiple IP cameras
- **Support for RTSP-compatible cameras** (Tapo, Amcrest, Hikvision, and others)
- **Multi-camera view** - view all cameras simultaneously with auto-arranging grid
- **Single camera view** - focus on one camera at a time
- **Automatic reconnection** on disconnect with exponential backoff
- **HLS streaming** for browser compatibility
- **Dark theme UI** with responsive design
- **Camera information modal** - view camera details, status, and settings
- **Error handling and retry mechanisms** for robust streaming
- **Configurable per-camera settings** - customize video/audio modes, decoders, and more
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

> **Note:** This project also includes a VS Code Dev Container configuration (`.devcontainer/devcontainer.json`) for development convenience, but it's **completely optional**. The project works perfectly fine with just Node.js and FFmpeg installed on your system.

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

**Hikvision NVR Channel:**

```json
CAMERAS=[
  {
    "id": "nvr_ch1",
    "name": "NVR Channel 1",
    "rtspUrl": "rtsp://admin:password@192.168.1.100:554/Streaming/Channels/102",
    "rtspTransport": "tcp",
    "videoMode": "reencode",
    "audioMode": "disabled"
  }
]
```

### Configuration Options

Each camera supports the following options:

**Required:**

- `id` - Unique identifier (e.g., "camera1", "nvr_ch1")
- `name` - Display name (e.g., "Front Door", "NVR Channel 1")
- `rtspUrl` - RTSP stream URL

**Optional (overrides global defaults):**

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
DEFAULT_ERROR_DETECTION=aggressive
VIDEO_PRESET=veryfast
MAX_THREADS=4
MAX_FPS=20
VIDEO_SCALE=1280:720
```

**CPU Limiting Options (to reduce CPU usage):**

- `VIDEO_PRESET` - Encoding preset: `ultrafast` (lowest CPU, lower quality), `superfast`, `veryfast` (default), `faster`, `fast`, `medium`, `slow`, `slower`, `veryslow` (highest CPU, best quality)
- `MAX_THREADS` - Limit CPU threads (e.g., `2`, `4`, `6`) - prevents using all CPU cores (default: auto-detect all cores)
- `MAX_FPS` - Limit frame rate (e.g., `15`, `20`, `25`, `30`) - reduces CPU usage (default: use source FPS)
- `VIDEO_SCALE` - Scale down resolution (e.g., `1280:720`, `1920:1080`) - significantly reduces CPU usage (default: no scaling)
- `VIDEO_BITRATE` - Reduce bitrate (e.g., `1024k`, `1536k`) - lower values use less CPU (default: `2048k`)

## 📹 Getting Your Camera RTSP URL

### Tapo Cameras

1. Open the Tapo app on your phone
2. Go to your camera's settings
3. Navigate to **Advanced Settings** > **Camera Account**
4. Create a username and password for RTSP access
5. Find your camera's local IP address (usually in network settings)
6. Use the format: `rtsp://username:password@camera_ip:554/stream1`
   - Use `/stream1` for high quality
   - Use `/stream2` for lower quality (better for slower networks)
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

1. Log into your NVR's web interface (usually `http://nvr_ip`)
2. Note your username and password (default is often `admin`/`admin` or `admin`/`12345`)
3. Find the channel numbers for your cameras (usually displayed in the NVR interface)
4. Use the format: `rtsp://username:password@nvr_ip:554/Streaming/Channels/[channel]01`
   - Replace `[channel]` with the channel number:
     - Channel 1: `101` (main stream) or `102` (sub stream)
     - Channel 2: `201` (main stream) or `202` (sub stream)
     - Channel 3: `301` (main stream) or `302` (sub stream)
     - And so on...
   - The last digit: `01` = main stream (high quality), `02` = sub stream (lower quality)
5. **Alternative RTSP format** (some Hikvision models):
   - `rtsp://username:password@nvr_ip:554/h264/ch[channel]/main/av_stream`
   - `rtsp://username:password@nvr_ip:554/h264/ch[channel]/sub/av_stream`

**Configuration options:**

- `rtspTransport: "tcp"` - Use TCP transport (recommended for H.265 streams and Hikvision NVRs)
- `videoDecoder: "hevc"` - Explicitly set decoder for H.265 streams
- `errorDetection: "aggressive"` - Recommended for corrupted streams
- `audioMode: "disabled"` - Disable audio if camera has no audio or produces noise

## 🎯 Usage

Start the server:

```bash
npm start
```

The server will:

- Start on `http://localhost:3000` (or the port specified in `.env`)
- Automatically begin streaming from all configured cameras
- Display cameras in multi-view or single-view mode
- Automatically reconnect if a stream disconnects

### View Modes

- **Single View**: Focus on one camera at a time with full-screen playback
- **Multi View**: View all cameras simultaneously in an auto-arranging grid

### Camera Information

Click the "ℹ️ Info" button on any camera to view:

- Camera name and ID
- Connection status
- RTSP URL (password masked)
- Transport protocol
- Video/Audio modes
- Decoder settings
- HLS configuration

## 🔧 API Endpoints

- `GET /api/cameras` - Get list of configured cameras
- `GET /api/stream/:cameraId/status` - Get current stream status
- `GET /api/stream/:cameraId/playlist.m3u8` - Get HLS playlist for a camera
- `POST /api/stream/:cameraId/start` - Manually start the stream
- `POST /api/stream/:cameraId/stop` - Stop the stream

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

- Remove `videoCodec: "copy"` if using passthrough mode - enable re-encoding instead
- Check if stream requires a stream key (try alternative RTSP paths)
- Verify camera stream is not encrypted
- Try different video decoder settings

### Corrupted video or decoding errors

- Set `errorDetection: "aggressive"` for the camera
- Set explicit `videoDecoder` (e.g., "h264" or "hevc")
- Try different RTSP transport (TCP vs UDP)
- Check network stability and packet loss

## 🏗️ Architecture

- **Backend**: Node.js + Express + FFmpeg (RTSP → HLS conversion)
- **Frontend**: HTML5 + Video.js (HLS playback)
- **Streaming**: HLS (HTTP Live Streaming) for browser compatibility
- **Configuration**: Environment variables via `.env` file

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
