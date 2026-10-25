const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const config = require("./config");

/** HLS / stream id for a camera's optional substream (grid/wall). */
function previewStreamId(cameraId) {
  return `${cameraId}-preview`;
}

class StreamManager {
  constructor() {
    this.streams = new Map(); // Map of streamId -> stream info
    this.onStatusChange = null;

    // Initialize main + optional preview streams for all cameras
    config.cameras.forEach((camera) => {
      this.streams.set(camera.id, {
        camera: camera,
        ffmpegProcess: null,
        isStreaming: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        stallTimer: null,
        lastSegmentMtimeMs: 0,
        isPreview: false,
      });

      if (camera.previewRtspUrl) {
        const previewId = previewStreamId(camera.id);
        this.streams.set(previewId, {
          camera: {
            ...camera,
            id: previewId,
            name: `${camera.name} (preview)`,
            rtspUrl: camera.previewRtspUrl,
            // Tiles don't need audio; saves CPU on substream encodes
            audioMode: "disabled",
          },
          ffmpegProcess: null,
          isStreaming: false,
          reconnectAttempts: 0,
          reconnectTimer: null,
          stallTimer: null,
          lastSegmentMtimeMs: 0,
          isPreview: true,
          parentCameraId: camera.id,
        });
      }
    });
  }

  /**
   * Start streaming from a specific camera (also starts preview if configured)
   */
  startStream(cameraId = null) {
    const targetCameraId = cameraId || config.cameras[0]?.id;
    this._startOne(targetCameraId);

    // Starting a main camera also starts its preview ingest
    const previewId = previewStreamId(targetCameraId);
    if (
      this.streams.has(previewId) &&
      !this.streams.get(targetCameraId)?.isPreview
    ) {
      this._startOne(previewId);
    }
  }

  _startOne(streamId) {
    const stream = this.streams.get(streamId);

    if (!stream) {
      console.error(`Stream ${streamId} not found`);
      return;
    }

    if (stream.isStreaming) {
      console.log(`Stream for ${streamId} already running`);
      return;
    }

    // Only wipe HLS on cold start; reconnects keep recent segments for the player
    this._ensureHlsDirectory(streamId, { clean: !stream._hasStartedOnce });
    stream._hasStartedOnce = true;
    this._startFFmpeg(streamId);
  }

  /**
   * Stop streaming from a specific camera (also stops preview if configured)
   */
  stopStream(cameraId = null) {
    const targetCameraId = cameraId || config.cameras[0]?.id;
    this._stopOne(targetCameraId);

    const previewId = previewStreamId(targetCameraId);
    if (
      this.streams.has(previewId) &&
      !this.streams.get(targetCameraId)?.isPreview
    ) {
      this._stopOne(previewId);
    }
  }

  _stopOne(streamId) {
    const stream = this.streams.get(streamId);

    if (!stream) {
      return;
    }

    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
    }
    this._stopStallWatch(streamId);

    if (stream.ffmpegProcess) {
      console.log(`Stopping FFmpeg process for ${streamId}...`);
      stream.ffmpegProcess.kill("SIGTERM");
      stream.ffmpegProcess = null;
    }

    stream.isStreaming = false;
    stream.reconnectAttempts = 0;
    this._updateStatus(streamId, "stopped");
  }

  /**
   * Start all camera streams (main + previews)
   */
  startAllStreams() {
    config.cameras.forEach((camera) => {
      this.startStream(camera.id);
    });
  }

  /**
   * Stop all camera streams (main + previews)
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
   * Get list of all cameras (includes live status for UI tiles)
   */
  getCameras() {
    return config.cameras.map((camera) => {
      const stream = this.streams.get(camera.id);
      const preview = this.streams.get(previewStreamId(camera.id));
      return {
        id: camera.id,
        name: camera.name,
        isStreaming: !!(stream && stream.isStreaming),
        reconnectAttempts: stream ? stream.reconnectAttempts : 0,
        hasPreview: !!camera.previewRtspUrl,
        previewStreaming: !!(preview && preview.isStreaming),
      };
    });
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

        // Determine thread count: per-camera override, global max, or auto-detect
        const threadCount =
          camera.maxThreads !== undefined
            ? camera.maxThreads
            : config.ffmpeg.maxThreads || 0; // 0 = auto-detect all cores

        // Determine frame rate limit: per-camera override or global max
        const maxFPS =
          camera.maxFPS !== undefined ? camera.maxFPS : config.ffmpeg.maxFPS;

        // Determine resolution scaling: per-camera override or global scale
        const videoScale =
          camera.videoScale !== undefined
            ? camera.videoScale
            : config.ffmpeg.scale;

        const bitrate = config.ffmpeg.videoBitrate;
        const bufsize = config.ffmpeg.videoBufsize || "4M";

        ffmpegCmd
          .addOption("-c:v", config.ffmpeg.videoCodec)
          .addOption("-b:v", bitrate)
          .addOption("-maxrate", bitrate)
          .addOption("-bufsize", bufsize)
          .addOption("-preset", config.ffmpeg.videoPreset)
          .addOption("-tune", "zerolatency")
          .addOption("-crf", config.ffmpeg.crf.toString())
          .addOption("-g", "30") // Keyframe every 1 second at 30fps (more frequent for corruption recovery)
          .addOption("-sc_threshold", "0") // Disable scene change detection
          .addOption("-pix_fmt", "yuv420p")
          .addOption("-profile:v", "baseline") // Use baseline profile for better browser compatibility
          .addOption("-level", "3.1") // H.264 level
          .addOption("-threads", threadCount.toString()); // Limit CPU threads (0 = auto-detect all cores)

        // Limit frame rate if specified (reduces CPU usage)
        if (maxFPS) {
          ffmpegCmd.addOption("-r", maxFPS.toString());
          console.log(`[${camera.name}] Limiting frame rate to ${maxFPS} FPS`);
        }

        // Scale down resolution if specified (significantly reduces CPU usage)
        if (videoScale) {
          ffmpegCmd.addOption("-vf", `scale=${videoScale}`);
          console.log(`[${camera.name}] Scaling video to ${videoScale}`);
        }

        ffmpegCmd
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
   * Ensure HLS output directory exists for a camera.
   * @param {string} cameraId
   * @param {{ clean?: boolean }} [opts] clean=true wipes old segments (cold start only)
   */
  _ensureHlsDirectory(cameraId, opts = {}) {
    const { clean = false } = opts;
    const hlsDir = path.resolve(config.hlsOutputDir, cameraId);
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
      console.log(`Created HLS output directory: ${hlsDir}`);
      return;
    }
    if (!clean) return;

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
    // RTSP socket timeout (microseconds). Dead sockets exit instead of hanging forever.
    const rtspTimeoutUs =
      camera.rtspTimeoutUs !== undefined
        ? camera.rtspTimeoutUs
        : config.ffmpeg.rtspTimeoutUs;
    const inputOptions = [
      "-rtsp_transport",
      transport,
      "-rtsp_flags",
      "prefer_tcp",
      "-timeout",
      String(rtspTimeoutUs),
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

    // Only force an input decoder for HEVC/H.265 (helps some NVRs).
    // Forcing "-c:v h264" on Hikvision often makes corrupt-stream decode worse.
    const decoder = (camera.videoDecoder || "").toLowerCase();
    if (decoder === "hevc" || decoder === "h265") {
      inputOptions.push("-c:v", "hevc");
      console.log(`[${camera.name}] Using configured video decoder: hevc`);
    } else if (decoder) {
      console.log(
        `[${camera.name}] Ignoring videoDecoder=${camera.videoDecoder} on input (auto-detect); use "hevc" only when needed`
      );
    } else {
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

    // Directory should already exist from _startOne / reconnect path
    this._ensureHlsDirectory(cameraId, { clean: false });

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
        stream.lastSegmentMtimeMs = Date.now();
        this._updateStatus(cameraId, "streaming");
        this._startStallWatch(cameraId);
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
          stream.lastSegmentMtimeMs = Date.now();
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
        this._stopStallWatch(cameraId);
        stream.isStreaming = false;
        stream.ffmpegProcess = null;
        this._updateStatus(cameraId, "error", err.message);
        this._scheduleReconnect(cameraId);
      })
      .on("end", () => {
        console.log(`FFmpeg process ended for ${cameraId}`);
        this._stopStallWatch(cameraId);
        stream.isStreaming = false;
        stream.ffmpegProcess = null;
        this._updateStatus(cameraId, "ended");
        this._scheduleReconnect(cameraId);
      });

    stream.ffmpegProcess.run();
  }

  /**
   * Watch HLS output; TERM hung encodes that stop writing segments.
   */
  _startStallWatch(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream) return;
    this._stopStallWatch(cameraId);

    const stallSec = config.ffmpeg.stallTimeoutSec;
    const intervalMs = Math.max(5000, Math.floor((stallSec * 1000) / 3));

    stream.stallTimer = setInterval(() => {
      this._checkStall(cameraId);
    }, intervalMs);
  }

  _stopStallWatch(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream || !stream.stallTimer) return;
    clearInterval(stream.stallTimer);
    stream.stallTimer = null;
  }

  _checkStall(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream || !stream.isStreaming || !stream.ffmpegProcess) return;

    const hlsDir = path.resolve(config.hlsOutputDir, cameraId);
    let newestMs = stream.lastSegmentMtimeMs || stream._streamStartTime || 0;

    try {
      if (fs.existsSync(hlsDir)) {
        const files = fs.readdirSync(hlsDir);
        for (const file of files) {
          if (!file.endsWith(".ts") && !file.endsWith(".m3u8")) continue;
          const st = fs.statSync(path.join(hlsDir, file));
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        }
      }
    } catch (err) {
      console.warn(`[${cameraId}] Stall check failed:`, err.message);
      return;
    }

    stream.lastSegmentMtimeMs = newestMs;
    const ageSec = (Date.now() - newestMs) / 1000;
    const stallSec = config.ffmpeg.stallTimeoutSec;

    // Grace period after start before stall can fire
    const startedAgo =
      (Date.now() - (stream._streamStartTime || Date.now())) / 1000;
    if (startedAgo < stallSec) return;

    if (ageSec > stallSec) {
      console.warn(
        `[${cameraId}] Stall detected — last HLS update ${Math.floor(
          ageSec
        )}s ago (> ${stallSec}s); terminating ffmpeg`
      );
      this._stopStallWatch(cameraId);
      try {
        stream.ffmpegProcess.kill("SIGTERM");
      } catch (err) {
        console.warn(`[${cameraId}] Failed to TERM stalled ffmpeg:`, err.message);
      }
      // error/end handlers schedule reconnect
    }
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
      // Do not wipe HLS on reconnect (keeps last segments available to the player)
      this._ensureHlsDirectory(cameraId, { clean: false });
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
module.exports.previewStreamId = previewStreamId;
