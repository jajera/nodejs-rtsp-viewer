require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Parse cameras from environment or use default
function parseCameras() {
  // Try to read CAMERAS from .env file directly to support multi-line JSON
  const envPath = path.join(__dirname, "..", ".env");
  let camerasJson = process.env.CAMERAS;

  // If CAMERAS is not set or looks incomplete, try reading from .env file
  if (
    !camerasJson ||
    camerasJson.trim() === "[" ||
    camerasJson.trim().startsWith("[\n")
  ) {
    try {
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, "utf8");
        // Extract CAMERAS value (handles multi-line)
        const camerasMatch = envContent.match(/^CAMERAS=\[(.*?)\]$/ms);
        if (camerasMatch) {
          camerasJson = "[" + camerasMatch[1] + "]";
        }
      }
    } catch (e) {
      console.error("Error reading .env file:", e);
    }
  }

  if (camerasJson) {
    try {
      // Clean up the JSON string (remove newlines but preserve structure)
      // First, normalize whitespace while preserving commas
      let cleaned = camerasJson
        .replace(/\s*\n\s*/g, " ") // Replace newlines and surrounding whitespace with space
        .replace(/\s+/g, " ") // Replace multiple spaces with single space
        .replace(/,\s*}/g, "}") // Remove trailing commas before closing braces (JSON5 style)
        .replace(/,\s*]/g, "]") // Remove trailing commas before closing brackets (JSON5 style)
        .replace(/\}\s*\{/g, "}, {") // Ensure comma between objects
        .trim();
      const cameras = JSON.parse(cleaned);
      if (!Array.isArray(cameras) || cameras.length === 0) {
        throw new Error("CAMERAS must be a non-empty array");
      }
      return cameras;
    } catch (e) {
      console.error("Error parsing CAMERAS JSON:", e);
      console.error("CAMERAS value:", camerasJson);
      throw new Error(`Failed to parse CAMERAS configuration: ${e.message}`);
    }
  }

  // Fallback to single camera from RTSP_URL for backward compatibility
  if (process.env.RTSP_URL) {
    return [
      {
        id: "camera1",
        name: "Camera 1",
        rtspUrl: process.env.RTSP_URL,
      },
    ];
  }

  // No configuration found - fail instead of using defaults
  throw new Error(
    "No camera configuration found. Please set CAMERAS in .env file or RTSP_URL for single camera."
  );
}

const cameras = parseCameras();

module.exports = {
  // Cameras configuration
  cameras: cameras,

  // Legacy single camera support (uses first camera)
  rtspUrl: cameras[0]?.rtspUrl,

  // Server configuration
  port: process.env.PORT || 3000,

  // HLS output directory
  hlsOutputDir: process.env.HLS_OUTPUT_DIR || "./hls",

  // FFmpeg settings for stability and quality
  ffmpeg: {
    // Video codec settings
    videoCodec: "libx264",
    videoBitrate: process.env.VIDEO_BITRATE || "2048k", // Match NVR default 2048 Kbps
    videoPreset: "veryfast", // Balance between quality and CPU usage
    crf: 23, // Quality (lower = better quality, 18-28 is good range)
    g: 60, // GOP size (keyframe interval)

    // Audio codec settings
    audioCodec: "aac",
    audioBitrate: "128k",
    audioChannels: 2,
    audioSampleRate: 44100,

    // HLS segment settings
    hlsTime: 2, // Segment duration in seconds (2-4 seconds for low latency)
    hlsListSize: 10, // Number of segments in playlist
    hlsFlags: "delete_segments+program_date_time+independent_segments", // Delete old segments, add program date time, independent segments
    hlsStartNumberSource: "epoch", // Use timestamp for segment numbering

    // RTSP input settings - default to TCP for better reliability (especially Hikvision NVRs)
    rtspTransport: "tcp", // TCP is more reliable for NVRs, can be overridden per camera
    rtspFlags: null, // No flags needed

    // Default video and audio modes (can be overridden per camera)
    // Video modes: 'reencode' or 'passthrough'
    // - 'reencode': Decode and re-encode video (ensures compatibility, uses more CPU)
    // - 'passthrough': Copy video stream without re-encoding (saves CPU, requires compatible codec)
    defaultVideoMode: process.env.DEFAULT_VIDEO_MODE || "reencode",

    // Audio modes: 'disabled', 'auto', or 'manual'
    // - 'disabled': No audio in output stream
    // - 'auto': Auto-detect and use first available audio stream
    // - 'manual': Use specific audio stream index (requires audioStreamIndex)
    defaultAudioMode: process.env.DEFAULT_AUDIO_MODE || "auto",

    // Default audio stream index for 'manual' mode
    defaultAudioStreamIndex: parseInt(
      process.env.DEFAULT_AUDIO_STREAM_INDEX || "0",
      10
    ),

    // Audio encoding modes: 'auto' or 'force'
    // - 'auto': Let FFmpeg handle sample rate/channel conversion automatically (recommended)
    // - 'force': Force specific sample rate and channels (may cause timestamp issues)
    defaultAudioEncodingMode: process.env.DEFAULT_AUDIO_ENCODING_MODE || "auto",

    // Default error detection mode for corrupted streams
    // Options: 'ignore_err', 'aggressive', 'careful', 'compliant'
    // - 'ignore_err': Ignore errors (least strict)
    // - 'aggressive': More aggressive error detection (recommended for corrupted streams)
    // - 'careful': Careful error detection
    // - 'compliant': Strict compliance checking (most strict)
    defaultErrorDetection: process.env.DEFAULT_ERROR_DETECTION || "aggressive",
  },

  // Reconnection settings
  reconnection: {
    maxRetries: Infinity, // Keep trying indefinitely
    initialDelay: 1000, // Start with 1 second delay
    maxDelay: 30000, // Max 30 seconds between retries
    backoffMultiplier: 1.5, // Exponential backoff multiplier
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",
};
