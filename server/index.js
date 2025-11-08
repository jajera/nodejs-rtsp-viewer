const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("./config");
const StreamManager = require("./streamManager");

const app = express();
const streamManager = new StreamManager();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "..", "public")));

// Serve HLS segments and playlists
app.use("/hls", express.static(config.hlsOutputDir));

// Get list of cameras
app.get("/api/cameras", (req, res) => {
  res.json(streamManager.getCameras());
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  const allStatus = streamManager.getStatus();
  const firstCamera = Object.values(allStatus)[0] || {};
  res.json({
    status: "ok",
    streaming: firstCamera.isStreaming || false,
    reconnectAttempts: firstCamera.reconnectAttempts || 0,
  });
});

// Stream status endpoint (all cameras or specific camera)
app.get("/api/stream/status", (req, res) => {
  const cameraId = req.query.cameraId;
  const status = streamManager.getStatus(cameraId);
  res.json(status);
});

// Start stream endpoint (specific camera or first camera)
app.post("/api/stream/start", (req, res) => {
  const cameraId = req.body.cameraId;
  streamManager.startStream(cameraId);
  res.json({ message: `Stream started for camera ${cameraId || "default"}` });
});

// Stop stream endpoint (specific camera or first camera)
app.post("/api/stream/stop", (req, res) => {
  const cameraId = req.body.cameraId;
  streamManager.stopStream(cameraId);
  res.json({ message: `Stream stopped for camera ${cameraId || "default"}` });
});

// HLS playlist endpoint for specific camera
app.get("/api/stream/:cameraId/playlist.m3u8", (req, res) => {
  const cameraId = req.params.cameraId;
  const playlistPath = path.resolve(
    config.hlsOutputDir,
    cameraId,
    "playlist.m3u8"
  );

  // Read and modify playlist to fix segment paths
  const fs = require("fs");
  try {
    if (fs.existsSync(playlistPath)) {
      let playlistContent = fs.readFileSync(playlistPath, "utf8");
      // Remove #EXT-X-ENDLIST to allow continuous streaming
      // FFmpeg may add this when it encounters errors, but we want continuous streaming
      playlistContent = playlistContent.replace(/#EXT-X-ENDLIST\s*\n?/g, "");
      // Replace relative segment paths with absolute paths
      // Matches lines that are just segment filenames (not starting with # or /)
      playlistContent = playlistContent.replace(
        /^([^#\/\s][^\s]*\.ts)$/gm,
        `/hls/${cameraId}/$1`
      );

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(playlistContent);
    } else {
      // Return a valid empty HLS playlist instead of 404
      // This allows the player to wait and retry instead of showing an error
      const emptyPlaylist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
# Stream is starting, please wait...
`;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.send(emptyPlaylist);
    }
  } catch (err) {
    console.error(`Error serving playlist for ${cameraId}:`, err);
    // Return empty playlist on error too, so player can retry
    const emptyPlaylist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
# Error reading playlist, retrying...
`;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(emptyPlaylist);
  }
});

// Legacy playlist endpoint (uses first camera)
app.get("/api/stream/playlist.m3u8", (req, res) => {
  const firstCameraId = config.cameras[0]?.id || "camera1";
  const playlistPath = path.resolve(
    config.hlsOutputDir,
    firstCameraId,
    "playlist.m3u8"
  );

  // Read and modify playlist to fix segment paths
  const fs = require("fs");
  try {
    if (fs.existsSync(playlistPath)) {
      let playlistContent = fs.readFileSync(playlistPath, "utf8");
      // Replace relative segment paths with absolute paths
      playlistContent = playlistContent.replace(
        /^(segment_\d+\.ts)$/gm,
        `/hls/${firstCameraId}/$1`
      );

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(playlistContent);
    } else {
      res
        .status(404)
        .json({ error: "Playlist not found. Stream may not be started." });
    }
  } catch (err) {
    console.error("Error serving playlist:", err);
    res.status(500).json({ error: "Error reading playlist" });
  }
});

// Start the server
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${config.port}`);
  console.log(`RTSP URL: ${config.rtspUrl.replace(/:[^:@]+@/, ":****@")}`);
  console.log(`HLS Output: ${config.hlsOutputDir}`);

  // Auto-start all streams on server start
  console.log("Auto-starting all camera streams...");
  streamManager.startAllStreams();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  streamManager.stopAllStreams();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  streamManager.stopAllStreams();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

// Log stream status changes
streamManager.setStatusCallback((status) => {
  console.log(
    `Stream status: ${status.status}${
      status.message ? " - " + status.message : ""
    }`
  );
});
