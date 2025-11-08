// Initialize Video.js player
let player; // Single view player
let multiViewPlayers = new Map(); // Multi-view players: cameraId -> player instance

// Stream configuration
const API_BASE = "";

// State management
let isRetrying = false;
let retryTimeout = null;
let statusCheckInterval = null;
let currentCameraId = null;
let cameras = [];
let currentViewMode = "single"; // "single" or "multi"

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  loadCameras().then(() => {
    initializePlayer();
    setupEventListeners();
    startStatusMonitoring();
    checkStreamStatus();
  });
});

/**
 * Initialize Video.js player with HLS support
 */
function initializePlayer() {
  player = videojs("video-player", {
    fluid: false, // Disable fluid mode for better control
    responsive: false,
    aspectRatio: "16:9", // Set aspect ratio
    html5: {
      vhs: {
        overrideNative: true,
      },
      nativeVideoTracks: false,
      nativeAudioTracks: false,
      nativeTextTracks: false,
    },
    playbackRates: [0.5, 1, 1.25, 1.5, 2],
    controls: true,
    preload: "auto",
    muted: false, // Ensure audio is not muted
  });

  // Ensure audio is enabled and unmuted
  player.ready(() => {
    player.muted(false);
    player.volume(1.0);
    if (player.tech_ && player.tech_.el_) {
      player.tech_.el_.muted = false;
      player.tech_.el_.volume = 1.0;
    }

    // Log audio tracks for debugging
    player.audioTracks().on("addtrack", () => {
      console.log("Audio track added");
    });

    // Handle source changes to stop previous audio
    player.on("loadstart", () => {
      // Ensure previous audio is stopped
      if (player.tech_ && player.tech_.el_) {
        const audioTracks = player.audioTracks();
        for (let i = 0; i < audioTracks.length; i++) {
          if (audioTracks[i] && audioTracks[i].enabled) {
            audioTracks[i].enabled = false;
          }
        }
      }
    });
  });

  // Error handling
  player.on("error", handlePlayerError);
  player.on("loadstart", () => {
    // Stop any previous audio when loading new source
    if (player.tech_ && player.tech_.el_) {
      const mediaEl = player.tech_.el_;
      if (mediaEl.audioTracks) {
        for (let i = 0; i < mediaEl.audioTracks.length; i++) {
          if (mediaEl.audioTracks[i] && mediaEl.audioTracks[i].enabled) {
            mediaEl.audioTracks[i].enabled = false;
          }
        }
      }
    }
    updateStatus("connecting", "Connecting to stream...");
  });
  player.on("loadeddata", () => {
    updateStatus("connected", "Stream connected");
    hideError();
    hideRetryButton();
    // Ensure audio is enabled after stream loads
    if (player.tech_ && player.tech_.el_) {
      const mediaEl = player.tech_.el_;
      mediaEl.muted = false;
      mediaEl.volume = 1.0;
    }
    player.muted(false);
    player.volume(1.0);
  });
  player.on("waiting", () => {
    updateStatus("buffering", "Buffering...");
  });
  player.on("playing", () => {
    updateStatus("connected", "Stream playing");
    // Ensure audio is unmuted when playing starts
    player.muted(false);
    player.volume(1.0);
    if (player.tech_ && player.tech_.el_) {
      player.tech_.el_.muted = false;
      player.tech_.el_.volume = 1.0;
    }
  });

  // Set HLS source for current camera when player is ready
  player.ready(() => {
    console.log("Video.js player ready");
    if (currentCameraId) {
      updatePlayerSource(currentCameraId);
    }
    // Try to play automatically
    player.play().catch((err) => {
      console.log("Autoplay prevented:", err);
      // User interaction required for autoplay in some browsers
    });
  });
}

/**
 * Load cameras from API
 */
async function loadCameras() {
  try {
    const response = await fetch(`${API_BASE}/api/cameras`);
    cameras = await response.json();

    const select = document.getElementById("camera-select");
    select.innerHTML = "";

    if (cameras.length === 0) {
      select.innerHTML = '<option value="">No cameras available</option>';
      return;
    }

    cameras.forEach((camera) => {
      const option = document.createElement("option");
      option.value = camera.id;
      option.textContent = camera.name;
      select.appendChild(option);
    });

    // Select first camera by default
    if (cameras.length > 0) {
      currentCameraId = cameras[0].id;
      select.value = currentCameraId;
    }
  } catch (error) {
    console.error("Error loading cameras:", error);
    const select = document.getElementById("camera-select");
    select.innerHTML = '<option value="">Error loading cameras</option>';
  }
}

/**
 * Update player source for a specific camera
 */
async function updatePlayerSource(cameraId) {
  if (!player) {
    console.error("Player not initialized");
    return;
  }

  // Stop current playback and disconnect audio/video completely
  player.pause();
  player.currentTime(0);
  player.muted(true);

  // Stop the media element directly
  if (player.tech_ && player.tech_.el_) {
    const mediaEl = player.tech_.el_;
    mediaEl.pause();
    mediaEl.muted = true;
    mediaEl.currentTime = 0;

    // Stop all audio tracks
    if (mediaEl.audioTracks) {
      for (let i = 0; i < mediaEl.audioTracks.length; i++) {
        if (mediaEl.audioTracks[i]) {
          mediaEl.audioTracks[i].enabled = false;
        }
      }
    }

    // Remove source to disconnect
    if (mediaEl.src) {
      mediaEl.src = "";
      mediaEl.load();
    }
  }

  // Small delay to ensure audio stops
  await new Promise((resolve) => setTimeout(resolve, 50));

  const hlsUrl = `/api/stream/${cameraId}/playlist.m3u8`;
  console.log(`Setting player source to: ${hlsUrl}`);

  currentCameraId = cameraId;

  // Set source and load
  player.src({
    src: hlsUrl,
    type: "application/x-mpegURL",
  });

  player.load(); // Explicitly load the new source

  // Unmute after loading new source and ensure audio is enabled
  setTimeout(() => {
    player.muted(false);
    player.volume(1.0);
    if (player.tech_ && player.tech_.el_) {
      const mediaEl = player.tech_.el_;
      mediaEl.muted = false;
      mediaEl.volume = 1.0;
      // Enable audio tracks if available
      if (mediaEl.audioTracks && mediaEl.audioTracks.length > 0) {
        for (let i = 0; i < mediaEl.audioTracks.length; i++) {
          if (mediaEl.audioTracks[i]) {
            mediaEl.audioTracks[i].enabled = true;
          }
        }
      }
    }
    player.play().catch((err) => {
      console.log("Play error:", err);
    });
  }, 100);

  console.log(`Switched to camera: ${cameraId}`);
}

/**
 * Setup event listeners for buttons
 */
function setupEventListeners() {
  // View mode toggle
  const singleViewBtn = document.getElementById("single-view-btn");
  const multiViewBtn = document.getElementById("multi-view-btn");

  if (singleViewBtn) {
    singleViewBtn.addEventListener("click", () => {
      switchViewMode("single");
    });
  }

  if (multiViewBtn) {
    multiViewBtn.addEventListener("click", () => {
      switchViewMode("multi");
    });
  }

  // Camera selector change (only in single view)
  const cameraSelect = document.getElementById("camera-select");
  if (cameraSelect) {
    cameraSelect.addEventListener("change", (e) => {
      if (currentViewMode === "single") {
        const selectedCameraId = e.target.value;
        if (selectedCameraId && selectedCameraId !== currentCameraId) {
          updatePlayerSource(selectedCameraId);
          checkStreamStatus();
        }
      }
    });
  }

  const retryBtn = document.getElementById("retry-btn");
  const refreshBtn = document.getElementById("refresh-btn");

  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      retryConnection();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshStream();
    });
  }
}

/**
 * Switch between single and multi view modes
 */
function switchViewMode(mode) {
  currentViewMode = mode;

  const singleView = document.getElementById("single-view");
  const multiView = document.getElementById("multi-view");
  const singleViewBtn = document.getElementById("single-view-btn");
  const multiViewBtn = document.getElementById("multi-view-btn");
  const cameraSelect = document.getElementById("camera-select");

  if (mode === "single") {
    singleView.style.display = "block";
    multiView.style.display = "none";
    singleViewBtn.classList.add("active");
    multiViewBtn.classList.remove("active");
    if (cameraSelect) {
      cameraSelect.parentElement.style.display = "flex";
    }

    // Stop all multi-view players
    multiViewPlayers.forEach((player, cameraId) => {
      if (player && !player.isDisposed()) {
        player.pause();
      }
    });

    // Resume single view player
    if (player && currentCameraId) {
      updatePlayerSource(currentCameraId);
    }
  } else {
    singleView.style.display = "none";
    multiView.style.display = "block";
    singleViewBtn.classList.remove("active");
    multiViewBtn.classList.add("active");
    if (cameraSelect) {
      cameraSelect.parentElement.style.display = "none";
    }

    // Pause single view player
    if (player && !player.isDisposed()) {
      player.pause();
    }

    // Initialize multi-view players
    initializeMultiView();
  }
}

/**
 * Initialize multi-view with all cameras
 */
function initializeMultiView() {
  const camerasGrid = document.getElementById("cameras-grid");
  if (!camerasGrid) return;

  // Clear existing players
  multiViewPlayers.forEach((player, cameraId) => {
    if (player && !player.isDisposed()) {
      player.dispose();
    }
  });
  multiViewPlayers.clear();
  camerasGrid.innerHTML = "";

  // Auto-arrange grid based on number of cameras
  const cameraCount = cameras.length;
  // Remove all grid classes
  camerasGrid.className = "cameras-grid";

  // Calculate optimal grid layout
  let columns = 1;
  if (cameraCount === 1) {
    columns = 1;
  } else if (cameraCount === 2) {
    columns = 2;
  } else if (cameraCount <= 4) {
    columns = 2; // 2x2 for 4 cameras
  } else if (cameraCount <= 6) {
    columns = 3; // 3 columns for 5-6 cameras
  } else if (cameraCount <= 9) {
    columns = 3; // 3x3 for 7-9 cameras
  } else if (cameraCount <= 12) {
    columns = 4; // 4 columns for 10-12 cameras
  } else {
    columns = 4; // Max 4 columns for more than 12
  }

  // Set grid template columns
  camerasGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;

  // Create player for each camera
  cameras.forEach((camera) => {
    const cameraItem = document.createElement("div");
    cameraItem.className = "camera-item";
    cameraItem.id = `camera-item-${camera.id}`;

    const label = document.createElement("div");
    label.className = "camera-label";
    label.innerHTML = `
      <span>${camera.name}</span>
      <button class="camera-info-btn" data-camera-id="${camera.id}" title="Camera Info">
        ℹ️ Info
      </button>
    `;
    cameraItem.appendChild(label);

    // Add click handler for info button
    const infoBtn = label.querySelector(".camera-info-btn");
    infoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showCameraInfo(camera);
    });

    const video = document.createElement("video");
    video.id = `video-player-${camera.id}`;
    video.className = "video-js vjs-default-skin";
    video.controls = true;
    video.preload = "auto";
    video.setAttribute("data-setup", "{}");
    cameraItem.appendChild(video);

    camerasGrid.appendChild(cameraItem);

    // Initialize Video.js player for this camera
    const cameraPlayer = videojs(`video-player-${camera.id}`, {
      fluid: false,
      responsive: false,
      aspectRatio: "16:9",
      html5: {
        vhs: {
          overrideNative: true,
        },
        nativeVideoTracks: false,
        nativeAudioTracks: false,
        nativeTextTracks: false,
      },
      controls: true,
      preload: "auto",
      muted: true, // Mute all in multi-view to avoid audio conflicts
    });

    // Set source
    const hlsUrl = `/api/stream/${camera.id}/playlist.m3u8`;
    cameraPlayer.src({
      src: hlsUrl,
      type: "application/x-mpegURL",
    });

    cameraPlayer.ready(() => {
      cameraPlayer.load();
      cameraPlayer.play().catch((err) => {
        console.log(`Autoplay prevented for ${camera.name}:`, err);
      });
    });

    multiViewPlayers.set(camera.id, cameraPlayer);
  });
}

/**
 * Show camera information modal
 */
function showCameraInfo(camera) {
  // Get stream status
  const stream = multiViewPlayers.get(camera.id);
  const status = stream && !stream.isDisposed() ? "Connected" : "Disconnected";

  // Create or get modal
  let modal = document.getElementById("camera-info-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "camera-info-modal";
    modal.className = "camera-info-modal";
    modal.innerHTML = `
      <div class="camera-info-content">
        <div class="camera-info-header">
          <h2>Camera Information</h2>
          <button class="camera-info-close">Close</button>
        </div>
        <div id="camera-info-body"></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close button handler
    modal.querySelector(".camera-info-close").addEventListener("click", () => {
      modal.classList.remove("active");
    });

    // Close on background click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.remove("active");
      }
    });
  }

  // Populate info
  const infoBody = document.getElementById("camera-info-body");
  infoBody.innerHTML = `
    <div class="camera-info-item">
      <label>Name:</label>
      <div class="value">${camera.name || "N/A"}</div>
    </div>
    <div class="camera-info-item">
      <label>Camera ID:</label>
      <div class="value">${camera.id || "N/A"}</div>
    </div>
    <div class="camera-info-item">
      <label>Status:</label>
      <div class="value">${status}</div>
    </div>
    <div class="camera-info-item">
      <label>RTSP URL:</label>
      <div class="value" style="word-break: break-all; font-size: 0.85em;">${
        camera.rtspUrl ? camera.rtspUrl.replace(/:[^:@]+@/, ":****@") : "N/A"
      }</div>
    </div>
    <div class="camera-info-item">
      <label>Transport:</label>
      <div class="value">${camera.rtspTransport || "tcp"}</div>
    </div>
    <div class="camera-info-item">
      <label>Video Mode:</label>
      <div class="value">${camera.videoMode || "reencode"}</div>
    </div>
    <div class="camera-info-item">
      <label>Audio Mode:</label>
      <div class="value">${camera.audioMode || "auto"}</div>
    </div>
    ${
      camera.videoDecoder
        ? `
    <div class="camera-info-item">
      <label>Video Decoder:</label>
      <div class="value">${camera.videoDecoder}</div>
    </div>
    `
        : ""
    }
    ${
      camera.hlsListSize
        ? `
    <div class="camera-info-item">
      <label>HLS List Size:</label>
      <div class="value">${camera.hlsListSize}</div>
    </div>
    `
        : ""
    }
  `;

  // Show modal
  modal.classList.add("active");
}

/**
 * Handle player errors
 */
function handlePlayerError(error) {
  console.error("Player error:", error);

  const errorCode = player.error();
  let errorMessage = "An error occurred while playing the video.";

  if (errorCode) {
    switch (errorCode.code) {
      case 1: // MEDIA_ERR_ABORTED
        errorMessage = "Video playback was aborted.";
        break;
      case 2: // MEDIA_ERR_NETWORK
        errorMessage = "Network error. Check your connection and try again.";
        updateStatus("disconnected", "Network error");
        scheduleAutoRetry();
        break;
      case 3: // MEDIA_ERR_DECODE
        errorMessage = "Video decoding error.";
        break;
      case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
        errorMessage = "Video format not supported or stream unavailable.";
        updateStatus("error", "Stream unavailable");
        scheduleAutoRetry();
        break;
    }
  }

  showError(errorMessage);
  showRetryButton();
  updateStatus("error", errorMessage);
}

/**
 * Retry connection manually
 */
function retryConnection() {
  if (isRetrying) return;

  isRetrying = true;
  updateStatus("reconnecting", "Retrying connection...");
  hideError();

  // Reload the player source for current camera
  if (currentCameraId) {
    const hlsUrl = `/api/stream/${currentCameraId}/playlist.m3u8?t=${Date.now()}`;
    player.src({
      src: hlsUrl,
      type: "application/x-mpegURL",
    });
  }

  player.load();
  player.play().catch((err) => {
    console.log("Play error on retry:", err);
  });

  setTimeout(() => {
    isRetrying = false;
  }, 3000);
}

/**
 * Refresh stream by reloading the page
 */
function refreshStream() {
  window.location.reload();
}

/**
 * Schedule automatic retry with exponential backoff
 */
function scheduleAutoRetry() {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }

  // Retry after 5 seconds
  retryTimeout = setTimeout(() => {
    console.log("Auto-retrying connection...");
    retryConnection();
  }, 5000);
}

/**
 * Check stream status from API
 */
async function checkStreamStatus() {
  try {
    const cameraId = currentCameraId || cameras[0]?.id;
    const url = cameraId
      ? `${API_BASE}/api/stream/status?cameraId=${cameraId}`
      : `${API_BASE}/api/stream/status`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.isStreaming && player.readyState() === 0) {
      updateStatus("disconnected", "Stream not available");
      showRetryButton();
    }
  } catch (error) {
    console.error("Error checking stream status:", error);
  }
}

/**
 * Start monitoring stream status periodically
 */
function startStatusMonitoring() {
  statusCheckInterval = setInterval(() => {
    checkStreamStatus();
  }, 5000); // Check every 5 seconds
}

/**
 * Update status indicator
 */
function updateStatus(status, message) {
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.getElementById("status-text");

  // Remove all status classes
  statusDot.classList.remove("connected", "disconnected", "reconnecting");

  // Add appropriate class
  switch (status) {
    case "connected":
    case "streaming":
      statusDot.classList.add("connected");
      statusText.textContent = message || "Connected";
      break;
    case "disconnected":
    case "error":
      statusDot.classList.add("disconnected");
      statusText.textContent = message || "Disconnected";
      break;
    case "reconnecting":
    case "connecting":
    case "buffering":
      statusDot.classList.add("reconnecting");
      statusText.textContent = message || "Reconnecting...";
      break;
    default:
      statusText.textContent = message || "Unknown";
  }
}

/**
 * Show error message
 */
function showError(message) {
  const errorEl = document.getElementById("error-message");
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

/**
 * Hide error message
 */
function hideError() {
  const errorEl = document.getElementById("error-message");
  errorEl.style.display = "none";
}

/**
 * Show retry button
 */
function showRetryButton() {
  document.getElementById("retry-btn").style.display = "block";
}

/**
 * Hide retry button
 */
function hideRetryButton() {
  document.getElementById("retry-btn").style.display = "none";
}

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
  if (player && !player.isDisposed()) {
    player.dispose();
  }
  // Dispose all multi-view players
  multiViewPlayers.forEach((player) => {
    if (player && !player.isDisposed()) {
      player.dispose();
    }
  });
  multiViewPlayers.clear();
});
