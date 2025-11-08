const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const config = require("./config");

class StreamManager {
  constructor() {
    this.streams = new Map(); // Map of cameraId -> stream info
    this.onStatusChange = null;

    // Initialize streams for all cameras
    config.cameras.forEach((camera) => {
      this.streams.set(camera.id, {
        camera: camera,
        ffmpegProcess: null,
        isStreaming: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
      });
    });
  }

  /**
   * Start streaming from a specific camera
   */
  startStream(cameraId = null) {
    const targetCameraId = cameraId || config.cameras[0]?.id;
    const stream = this.streams.get(targetCameraId);

    if (!stream) {
      console.error(`Camera ${targetCameraId} not found`);
      return;
    }

    if (stream.isStreaming) {
      console.log(`Stream for ${targetCameraId} already running`);
      return;
    }

    this._ensureHlsDirectory(targetCameraId);
    this._startFFmpeg(targetCameraId);
  }

  /**
   * Stop streaming from a specific camera
   */
  stopStream(cameraId = null) {
    const targetCameraId = cameraId || config.cameras[0]?.id;
    const stream = this.streams.get(targetCameraId);

    if (!stream) {
      return;
    }

    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
    }

    if (stream.ffmpegProcess) {
      console.log(`Stopping FFmpeg process for ${targetCameraId}...`);
      stream.ffmpegProcess.kill("SIGTERM");
      stream.ffmpegProcess = null;
    }

    stream.isStreaming = false;
    stream.reconnectAttempts = 0;
    this._updateStatus(targetCameraId, "stopped");
  }

  /**
   * Start all camera streams
   */
  startAllStreams() {
    config.cameras.forEach((camera) => {
      this.startStream(camera.id);
    });
  }

  /**
   * Stop all camera streams
   */
  stopAllStreams() {
    config.cameras.forEach((camera) => {
      this.stopStream(camera.id);
    });
  }

  /**
   * Get streaming status for a specific camera or all cameras
   */
  getStatus(cameraId = null) {
    if (cameraId) {
      const stream = this.streams.get(cameraId);
      if (!stream) {
        return null;
      }
      return {
        cameraId: cameraId,
        cameraName: stream.camera.name,
        isStreaming: stream.isStreaming,
        reconnectAttempts: stream.reconnectAttempts,
      };
    }

    // Return status for all cameras
    const allStatus = {};
    this.streams.forEach((stream, id) => {
      allStatus[id] = {
        cameraId: id,
        cameraName: stream.camera.name,
        isStreaming: stream.isStreaming,
        reconnectAttempts: stream.reconnectAttempts,
      };
    });
    return allStatus;
  }

  /**
   * Get list of all cameras
   */
  getCameras() {
    return config.cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
    }));
  }

  /**
   * Set callback for status changes
   */
  setStatusCallback(callback) {
    this.onStatusChange = callback;
  }

  /**
   * Configure audio stream mapping and encoding based on explicit mode
   */
  _configureAudio(ffmpegCmd, camera) {
    // Determine audio mode: per-camera override or global default
    const audioMode = camera.audioMode || config.ffmpeg.defaultAudioMode;
    const audioStreamIndex =
      camera.audioStreamIndex !== undefined
        ? camera.audioStreamIndex
        : config.ffmpeg.defaultAudioStreamIndex;
    const audioEncodingMode =
      camera.audioEncodingMode || config.ffmpeg.defaultAudioEncodingMode;

    console.log(
      `[${camera.name}] Audio mode: ${audioMode}${
        audioMode === "manual" ? ` (stream index: ${audioStreamIndex})` : ""
      }, encoding: ${audioEncodingMode}`
    );

    switch (audioMode) {
      case "disabled":
        // No audio mapping - stream will have no audio track
        console.log(`[${camera.name}] Audio disabled`);
        break;

      case "manual":
        // Use specific audio stream index
        console.log(
          `[${camera.name}] Using audio stream index: ${audioStreamIndex}`
        );
        ffmpegCmd.addOption("-map", `0:a:${audioStreamIndex}?`);
        this._addAudioEncoding(ffmpegCmd, audioEncodingMode);
        break;

      case "auto":
      default:
        // Auto-detect first available audio stream
        console.log(`[${camera.name}] Auto-detecting audio stream`);
        ffmpegCmd.addOption("-map", "0:a?");
        this._addAudioEncoding(ffmpegCmd, audioEncodingMode);
        break;
    }
  }

  /**
   * Add audio encoding options based on encoding mode
   */
  _addAudioEncoding(ffmpegCmd, audioEncodingMode) {
    ffmpegCmd
      .addOption("-c:a", config.ffmpeg.audioCodec)
      .addOption("-b:a", config.ffmpeg.audioBitrate);
    // Note: -strict -2 is obsolete and removed

    if (audioEncodingMode === "force") {
      // Force specific sample rate and channels
      // Note: This may cause timestamp issues with some streams
      ffmpegCmd
        .addOption("-ac", config.ffmpeg.audioChannels.toString())
        .addOption("-ar", config.ffmpeg.audioSampleRate.toString())
        .addOption("-af", "aresample=resampler=soxr");
    }
    // 'auto' mode: Let FFmpeg handle sample rate/channel conversion automatically (default)
  }

  /**
   * Configure video encoding based on explicit mode
   */
  _configureVideo(ffmpegCmd, camera) {
    // Determine video mode: per-camera override or global default
    const videoMode = camera.videoMode || config.ffmpeg.defaultVideoMode;

    console.log(`[${camera.name}] Video mode: ${videoMode}`);

    switch (videoMode) {
      case "passthrough":
        // Copy video stream without re-encoding (saves CPU)
        // NOTE: For H.265/HEVC streams, use fMP4 segments, not .ts
        // For Hikvision NVRs, reencode mode is recommended
        console.log(
          `[${camera.name}] Using video passthrough (no re-encoding)`
        );
        // Note: This assumes H.264 input. For H.265, would need hevc_mp4toannexb and fMP4 segments
        ffmpegCmd
          .addOption("-c:v", "copy")
          .addOption("-bsf:v", "h264_mp4toannexb") // Convert to Annex-B format for HLS (H.264 only)
          .addOption("-avoid_negative_ts", "make_zero");
        break;

      case "reencode":
      default:
        // Re-encode to H.264 for universal browser compatibility
        // Ensures compatibility by decoding any format and encoding to H.264
        // Automatically handles H.265/HEVC decoding if present
        // This is the recommended mode for Hikvision NVRs
        // Log re-encoding operation (codec will be auto-detected or use configured decoder)
        const codecInfo = camera.videoDecoder
          ? `using decoder ${camera.videoDecoder}`
          : "auto-detecting codec";
        console.log(
          `[${camera.name}] Re-encoding video to H.264 (${codecInfo})`
        );
        // GOP size: for 30fps and 2s segments, use 60 (30fps * 2s)
        // This ensures each segment starts with a keyframe
        // Handle variable frame rate from NVR (Full Frame setting)
        // Use 'cfr' for constant frame rate, or 'vfr' to preserve variable rate
        const vsyncMode = camera.vsyncMode || "cfr"; // Default to constant for HLS compatibility

        ffmpegCmd
          .addOption("-c:v", config.ffmpeg.videoCodec)
          .addOption("-b:v", config.ffmpeg.videoBitrate)
          .addOption("-preset", config.ffmpeg.videoPreset)
          .addOption("-crf", config.ffmpeg.crf.toString())
          .addOption("-g", "30") // Keyframe every 1 second at 30fps (more frequent for corruption recovery)
          .addOption("-sc_threshold", "0") // Disable scene change detection
          .addOption("-pix_fmt", "yuv420p")
          .addOption("-profile:v", "baseline") // Use baseline profile for better browser compatibility
          .addOption("-level", "3.1") // H.264 level
          .addOption("-threads", "0") // Auto-detect optimal thread count
          // Force keyframes more frequently to help with corruption recovery
          .addOption("-force_key_frames", "expr:gte(n,n_forced*30)")
          .addOption("-vsync", vsyncMode)
          // Don't force frame rate - let it match source automatically
          // Set proper color space for browser compatibility
          // Use BT.709 which is standard for video, but only if source doesn't specify
          .addOption("-colorspace", "bt709")
          .addOption("-color_primaries", "bt709")
          .addOption("-color_trc", "bt709")
          // Ensure clean output for HLS
          .addOption("-flags", "+global_header")
          .addOption("-avoid_negative_ts", "make_zero");
        break;
    }
  }

  /**
   * Ensure HLS output directory exists for a camera and clean old segments
   */
  _ensureHlsDirectory(cameraId) {
    const hlsDir = path.resolve(config.hlsOutputDir, cameraId);
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
      console.log(`Created HLS output directory: ${hlsDir}`);
    } else {
      // Clean up old segments and playlist on startup for fresh stream
      try {
        const files = fs.readdirSync(hlsDir);
        let cleanedCount = 0;
        files.forEach((file) => {
          if (file.endsWith(".ts") || file.endsWith(".m3u8")) {
            try {
              fs.unlinkSync(path.join(hlsDir, file));
              cleanedCount++;
            } catch (err) {
              // Ignore errors deleting individual files
            }
          }
        });
        if (cleanedCount > 0) {
          console.log(`Cleaned ${cleanedCount} old HLS files from ${cameraId}`);
        }
      } catch (err) {
        console.warn(
          `Warning: Could not clean HLS directory for ${cameraId}:`,
          err.message
        );
      }
    }
  }

  /**
   * Start FFmpeg process for a specific camera
   */
  _startFFmpeg(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream) return;

    const camera = stream.camera;
    const hlsPlaylist = path.join(
      config.hlsOutputDir,
      cameraId,
      "playlist.m3u8"
    );

    console.log(
      `Starting FFmpeg stream for ${
        camera.name
      } (${cameraId}) from: ${camera.rtspUrl.replace(/:[^:@]+@/, ":****@")}`
    );

    // RTSP input options - default to TCP for better reliability (especially Hikvision NVRs)
    // Hikvision NVRs work much better with TCP transport
    const transport =
      camera.rtspTransport || config.ffmpeg.rtspTransport || "tcp";
    const inputOptions = [
      "-rtsp_transport",
      transport,
      "-rtsp_flags",
      "prefer_tcp",
      "-stimeout",
      "10000000",
      // Larger buffer for H.265 streams
      "-buffer_size",
      "4096000",
      // Thread queue for better H.265 decoding
      "-thread_queue_size",
      "2048",
      // Extended probe for stream detection
      "-analyzeduration",
      "5000000", // 5 seconds - enough for stream detection
      "-probesize",
      "5000000", // 5 seconds - enough for stream detection
      // Error resilience - handle corrupted H.264/H.265 streams
      "-fflags",
      "+genpts+discardcorrupt+igndts",
      "-flags",
      "+global_header",
      // Skip loop filter to handle corrupted frames
      "-skip_loop_filter",
      "all",
      // Additional options for corrupted streams (allow experimental codecs like HEVC)
      "-strict",
      "-2", // Allow experimental codecs (HEVC)
      // Wait for valid data before starting
      "-max_interleave_delta",
      "100000000",
      // Don't exit on error - keep trying to decode (1.0 = 100% error tolerance)
      "-max_error_rate",
      "1.0",
    ];

    if (transport === "tcp") {
      console.log(`Using TCP transport for ${camera.name}`);
    }

    // Use configured input video decoder if specified, otherwise let FFmpeg auto-detect
    // This allows per-camera configuration via videoDecoder in .env
    if (camera.videoDecoder) {
      inputOptions.push("-c:v", camera.videoDecoder);
      console.log(
        `[${camera.name}] Using configured video decoder: ${camera.videoDecoder}`
      );
    } else {
      // Let FFmpeg auto-detect the codec - no assumptions
      console.log(`[${camera.name}] Auto-detecting video codec from stream`);
    }

    // Use configured error detection mode, or default from config
    const errorDetection =
      camera.errorDetection || config.ffmpeg.defaultErrorDetection;
    inputOptions.push("-err_detect", errorDetection);

    const ffmpegCmd = ffmpeg(camera.rtspUrl)
      .inputOptions(inputOptions)
      // Map video stream
      .addOption("-map", "0:v:0");

    // Configure audio based on explicit mode
    this._configureAudio(ffmpegCmd, camera);

    // Configure video based on explicit mode
    this._configureVideo(ffmpegCmd, camera);

    // Ensure HLS directory exists before starting
    this._ensureHlsDirectory(cameraId);

    // Prepare HLS flags for continuous streaming
    // Add append_list to ensure continuous streaming
    let hlsFlags = config.ffmpeg.hlsFlags;
    if (!hlsFlags.includes("append_list")) {
      hlsFlags = hlsFlags + "+append_list";
    }
    // Ensure delete_segments is enabled for cleanup
    if (!hlsFlags.includes("delete_segments")) {
      hlsFlags = hlsFlags + "+delete_segments";
    }
    // Keep delete_segments for cleanup, but ensure continuous streaming

    // Use configured HLS list size, or default from config
    const hlsListSize = camera.hlsListSize || config.ffmpeg.hlsListSize;

    stream.ffmpegProcess = ffmpegCmd
      .addOption("-f", "hls")
      .addOption("-hls_time", config.ffmpeg.hlsTime.toString())
      // HLS list size - number of segments to keep in playlist
      // Larger values = more buffering but more disk usage
      .addOption("-hls_list_size", hlsListSize.toString())
      .addOption("-hls_flags", hlsFlags)
      // Use sequential numbering instead of epoch to avoid huge numbers
      // Start from 0 and increment sequentially
      .addOption("-hls_start_number_source", "generic")
      .addOption("-start_number", "0")
      .addOption(
        "-hls_segment_filename",
        path.join(config.hlsOutputDir, cameraId, "segment_%d.ts")
      )
      .output(hlsPlaylist)
      .on("start", (commandLine) => {
        console.log(`FFmpeg command for ${cameraId}: ${commandLine}`);
        stream.isStreaming = true;
        stream.reconnectAttempts = 0;
        // Initialize stream start time to suppress initial error noise
        stream._streamStartTime = Date.now();
        stream._h264ErrorLogged = false; // Reset error logging flag
        this._updateStatus(cameraId, "streaming");
      })
      .on("stderr", (stderrLine) => {
        // Log detected video codec (critical for debugging)
        const videoCodecMatch = stderrLine.match(/Video:\s*(\w+)/);
        if (videoCodecMatch) {
          console.log(
            `[${cameraId}] Detected video codec: ${videoCodecMatch[1]}`
          );
        }
        // Log stream information to help debug audio issues
        if (stderrLine.includes("Stream #0") && stderrLine.includes("Audio")) {
          console.log(
            `[${cameraId}] Audio stream detected: ${stderrLine.trim()}`
          );
        }
        // Log output stream mapping to verify audio is included
        if (
          stderrLine.includes("Stream #0:") &&
          stderrLine.includes("->") &&
          stderrLine.includes("Audio")
        ) {
          console.log(`[${cameraId}] Audio mapping: ${stderrLine.trim()}`);
        }
        // Log connection status
        if (stderrLine.includes("Input #0") && stderrLine.includes("rtsp")) {
          console.log(`[${cameraId}] Successfully connected to RTSP stream`);
        }
        // Log connection errors
        if (stderrLine.match(/(Connection|timeout|refused|failed)/i)) {
          console.warn(`[${cameraId}] Connection issue: ${stderrLine.trim()}`);
        }
        // Log HLS segment creation
        if (stderrLine.includes("Opening") && stderrLine.includes(".ts")) {
          console.log(`[${cameraId}] Creating segment: ${stderrLine.trim()}`);
        }
        // Log H.265 decoding issues
        if (
          stderrLine.includes("hevc") &&
          (stderrLine.includes("error") || stderrLine.includes("failed"))
        ) {
          console.warn(
            `[${cameraId}] H.265 decoding issue: ${stderrLine.trim()}`
          );
        }
        // Don't log H.264 decoding errors - they're expected with this NVR stream
        // FFmpeg handles them automatically (conceals errors, continues decoding)
        // These are warnings, not failures - the stream still works
        // Logging them just creates noise since they happen constantly
      })
      .on("error", (err, stdout, stderr) => {
        // Don't treat decoding errors as fatal - FFmpeg can recover
        const isDecodingError =
          err.message.includes("decode") ||
          err.message.includes("Invalid data") ||
          err.message.includes("error while decoding");

        if (isDecodingError && stream.isStreaming) {
          // Log but don't restart - FFmpeg will continue despite decoding errors
          console.warn(
            `[${cameraId}] Non-fatal decoding error (FFmpeg will continue): ${err.message}`
          );
          return; // Don't treat as fatal error
        }

        console.error(`FFmpeg error for ${cameraId}:`, err.message);
        if (stderr) {
          console.error(`FFmpeg stderr for ${cameraId}:`, stderr);
          // Log stream information to help debug audio issues
          const streamInfo = stderr.match(/Stream #0:\d+.*/g);
          if (streamInfo) {
            console.log(`Available streams for ${cameraId}:`, streamInfo);
          }
          // Log critical errors that prevent segment creation
          if (
            stderr.includes("Cannot determine format") ||
            stderr.includes("Error opening") ||
            stderr.includes("Connection refused") ||
            stderr.includes("timeout")
          ) {
            console.error(
              `[${cameraId}] Critical FFmpeg error preventing stream creation`
            );
          }
        }
        stream.isStreaming = false;
        stream.ffmpegProcess = null;
        this._updateStatus(cameraId, "error", err.message);
        this._scheduleReconnect(cameraId);
      })
      .on("end", () => {
        console.log(`FFmpeg process ended for ${cameraId}`);
        stream.isStreaming = false;
        stream.ffmpegProcess = null;
        this._updateStatus(cameraId, "ended");
        this._scheduleReconnect(cameraId);
      });

    stream.ffmpegProcess.run();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  _scheduleReconnect(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream || stream.reconnectTimer) {
      return; // Already scheduled or stream doesn't exist
    }

    const delay = this._calculateReconnectDelay(stream.reconnectAttempts);
    console.log(
      `Scheduling reconnection for ${cameraId} in ${delay}ms (attempt ${
        stream.reconnectAttempts + 1
      })`
    );

    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      stream.reconnectAttempts++;
      this._updateStatus(
        cameraId,
        "reconnecting",
        `Attempt ${stream.reconnectAttempts}`
      );
      this._startFFmpeg(cameraId);
    }, delay);
  }

  /**
   * Calculate reconnection delay with exponential backoff
   */
  _calculateReconnectDelay(reconnectAttempts) {
    const { initialDelay, maxDelay, backoffMultiplier } = config.reconnection;
    const delay = Math.min(
      initialDelay * Math.pow(backoffMultiplier, reconnectAttempts),
      maxDelay
    );
    return Math.floor(delay);
  }

  /**
   * Update status and notify callback
   */
  _updateStatus(cameraId, status, message = "") {
    const stream = this.streams.get(cameraId);
    if (this.onStatusChange && stream) {
      this.onStatusChange({
        cameraId: cameraId,
        cameraName: stream.camera.name,
        status,
        message,
        isStreaming: stream.isStreaming,
        reconnectAttempts: stream.reconnectAttempts,
      });
    }
  }
}

module.exports = StreamManager;
