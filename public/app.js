const API_BASE = "";
const FAST_TRIES = 4;
const OFFLINE_MS = 30_000;
const MAX_FAST_DELAY_MS = 15_000;
const FS_IDLE_MS = 2500;
/** Per-camera mute prefs for watch view (home/compare stay muted for autoplay). */
const MUTE_STORAGE_KEY = "rtsp-viewer-camera-mute";

/** @type {Array<{id: string, name: string, isStreaming?: boolean, hasPreview?: boolean, previewStreaming?: boolean}>} */
let cameras = [];
/** @type {"home"|"watch"|"compare"} */
let currentViewMode = "home";
let currentCameraId = null;
/** @type {Set<string>} */
const picked = new Set();
/** @type {string[]} */
let compareCamIds = [];

/** @type {PlayerSession|null} */
let watchSession = null;
/** @type {Map<string, PlayerSession>} */
const homeSessions = new Map();
/** @type {Map<string, PlayerSession>} */
const compareSessions = new Map();
/** @type {Map<string, PlayerSession>} */
const fsWallSessions = new Map();

let statusPollTimer = null;
let mosaicResizeTimer = null;
let fsWallOpen = false;
let fsIdleTimer = null;
/** @type {IntersectionObserver|null} */
let visibilityObserver = null;
let urlSyncReady = false;
/** @type {HTMLElement|null} */
let fsFocusBefore = null;

function loadMuteMap() {
  try {
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** @returns {boolean} true = muted; default unmuted in watch */
function getCameraMuted(cameraId) {
  const map = loadMuteMap();
  return map[cameraId] === true;
}

function setCameraMuted(cameraId, muted) {
  try {
    const map = loadMuteMap();
    if (muted) map[cameraId] = true;
    else delete map[cameraId];
    localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {
    /* private mode / quota */
  }
}

function announce(msg) {
  const el = document.getElementById("a11y-live");
  if (!el || !msg) return;
  el.textContent = "";
  requestAnimationFrame(() => {
    el.textContent = msg;
  });
}

/**
 * Per-player reconnect state machine (LivePlayer-style).
 */
class PlayerSession {
  /**
   * @param {object} opts
   * @param {string} opts.cameraId
   * @param {import('video.js').VideoJsPlayer} opts.player
   * @param {HTMLElement|null} opts.frameEl
   * @param {HTMLElement|null} opts.overlayEl
   * @param {HTMLElement|null} opts.overlayMsgEl
   * @param {HTMLElement|null} opts.liveBadgeEl
   * @param {boolean} opts.muted
   * @param {"main"|"preview"} [opts.variant] playlist variant (preview = substream)
   * @param {boolean} [opts.persistMute] save mute toggles to localStorage (watch view)
   * @param {(status: string, message: string) => void} [opts.onStatus]
   */
  constructor(opts) {
    this.cameraId = opts.cameraId;
    this.player = opts.player;
    this.frameEl = opts.frameEl;
    this.overlayEl = opts.overlayEl;
    this.overlayMsgEl = opts.overlayMsgEl;
    this.liveBadgeEl = opts.liveBadgeEl;
    this.muted = !!opts.muted;
    this.variant = opts.variant === "preview" ? "preview" : "main";
    this.persistMute = !!opts.persistMute;
    this.onStatus = opts.onStatus || null;

    this.fails = 0;
    this.delay = 1000;
    this.retryTimer = null;
    this.stopped = false;
    this.live = false;
    this.suspended = false;
    this.offscreen = false;

    this._onError = () => this._handleFatal();
    this._onPlaying = () => this._onSuccess();
    this._onLoadedData = () => this._onSuccess();
    this._onWaiting = () => {
      if (!this.live) this._setUi("connecting", "Connecting…");
    };
    this._onLoadStart = () => {
      if (!this.live) this._setUi("connecting", "Connecting…");
    };
    this._onVolumeChange = () => {
      if (!this.persistMute || this.stopped || !this.player) return;
      const muted = this.player.muted();
      this.muted = muted;
      setCameraMuted(this.cameraId, muted);
    };

    this.player.on("error", this._onError);
    this.player.on("playing", this._onPlaying);
    this.player.on("loadeddata", this._onLoadedData);
    this.player.on("waiting", this._onWaiting);
    this.player.on("loadstart", this._onLoadStart);
    if (this.persistMute) {
      this.player.on("volumechange", this._onVolumeChange);
    }

    this.player.muted(this.muted);
    this.attach(false);
  }

  playlistUrl(bustCache) {
    const file =
      this.variant === "preview" ? "preview.m3u8" : "playlist.m3u8";
    const base = `/api/stream/${this.cameraId}/${file}`;
    return bustCache ? `${base}?t=${Date.now()}` : base;
  }

  attach(bustCache) {
    if (this.stopped || !this.player || this.player.isDisposed()) return;
    if (this.suspended || this.offscreen) return;

    this._clearRetry();
    if (this.fails === 0) {
      this._setUi("connecting", "Connecting…");
    }

    this.player.src({
      src: this.playlistUrl(bustCache),
      type: "application/x-mpegURL",
    });
    this.player.load();
    this.player.muted(this.muted);
    this.player.play().catch(() => {});
  }

  blank() {
    if (!this.player || this.player.isDisposed()) return;
    try {
      this.player.pause();
      this.player.error(null);
      const el = this.player.tech_ && this.player.tech_.el_;
      if (el) {
        el.removeAttribute("src");
        el.load();
      }
    } catch (_) {
      /* ignore */
    }
  }

  /** Pause decode without tearing down (FS wall / leave page briefly). */
  suspend() {
    if (this.stopped || this.suspended) return;
    this.suspended = true;
    this._clearRetry();
    this.blank();
  }

  resume() {
    if (this.stopped || !this.suspended) return;
    this.suspended = false;
    this.fails = 0;
    this.delay = 1000;
    this.live = false;
    if (!this.offscreen) this.attach(true);
  }

  /** Pause when scrolled/layout off-screen; resume when visible again. */
  setOffscreen(off) {
    if (this.stopped) return;
    if (off === this.offscreen) return;
    this.offscreen = off;
    if (off) {
      this._clearRetry();
      if (this.player && !this.player.isDisposed()) {
        try {
          this.player.pause();
        } catch (_) {
          /* ignore */
        }
      }
    } else if (!this.suspended) {
      if (this.live && this.player && !this.player.isDisposed()) {
        this.player.play().catch(() => this.attach(false));
      } else {
        this.attach(false);
      }
    }
  }

  _handleFatal() {
    if (this.stopped || this.suspended || this.offscreen) return;
    const err = this.player.error();
    if (!err) return;
    this._scheduleRetry();
  }

  _onSuccess() {
    if (this.stopped || this.suspended) return;
    this.fails = 0;
    this.delay = 1000;
    this.live = true;
    this._clearRetry();
    this._setUi("connected", "Live");
    this.player.muted(this.muted);
    if (!this.muted) this.player.volume(1);
  }

  _scheduleRetry() {
    if (this.stopped || this.retryTimer || this.suspended || this.offscreen)
      return;

    this.fails += 1;
    const offline = this.fails >= FAST_TRIES;
    this.delay = offline
      ? OFFLINE_MS
      : Math.min(this.delay * 2, MAX_FAST_DELAY_MS);

    this.live = false;
    this._setUi(
      offline ? "disconnected" : "reconnecting",
      offline ? "No signal" : "Reconnecting…"
    );
    this.blank();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attach(true);
    }, this.delay);
  }

  retryNow() {
    if (this.stopped) return;
    this.suspended = false;
    this.offscreen = false;
    this._clearRetry();
    this.fails = 0;
    this.delay = 1000;
    this.live = false;
    this._setUi("reconnecting", "Reconnecting…");
    this.blank();
    this.attach(true);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.persistMute) setCameraMuted(this.cameraId, muted);
    if (this.player && !this.player.isDisposed()) {
      this.player.muted(muted);
    }
  }

  _setUi(status, message) {
    if (this.frameEl) {
      this.frameEl.classList.toggle("is-down", status !== "connected");
    }
    if (this.liveBadgeEl) {
      this.liveBadgeEl.classList.toggle("hidden", status !== "connected");
    }
    if (this.overlayEl && this.overlayMsgEl) {
      if (status === "connected") {
        this.overlayEl.classList.add("hidden");
      } else {
        this.overlayEl.classList.remove("hidden");
        this.overlayMsgEl.textContent = message;
      }
    }
    if (this.onStatus) this.onStatus(status, message);
  }

  _clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  dispose() {
    this.stopped = true;
    this._clearRetry();
    if (this.player && !this.player.isDisposed()) {
      this.player.off("error", this._onError);
      this.player.off("playing", this._onPlaying);
      this.player.off("loadeddata", this._onLoadedData);
      this.player.off("waiting", this._onWaiting);
      this.player.off("loadstart", this._onLoadStart);
      if (this.persistMute) {
        this.player.off("volumechange", this._onVolumeChange);
      }
      try {
        this.player.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    this.player = null;
  }
}

function vjsOptions({ muted, controls }) {
  return {
    fluid: false,
    responsive: false,
    aspectRatio: "16:9",
    html5: {
      vhs: { overrideNative: true },
      nativeVideoTracks: false,
      nativeAudioTracks: false,
      nativeTextTracks: false,
    },
    controls: !!controls,
    preload: "auto",
    muted: !!muted,
    bigPlayButton: !!controls,
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function disposeMap(map) {
  map.forEach((session) => session.dispose());
  map.clear();
}

/** Shared column picker for home mosaic, compare, and FS wall. */
function compareGridCols(n) {
  const c = Number(n) || 0;
  if (c <= 1) return 1;
  if (c === 2) return 2;
  if (c === 3) return 3;
  if (c === 4) return 2;
  if (c <= 6) return 3;
  if (c === 9) return 3;
  if (c <= 12) return 4;
  if (c <= 16) return 4;
  if (c <= 24) return 6;
  return Math.min(8, Math.ceil(Math.sqrt(c)));
}

function setCompareCols(grid, n) {
  if (!grid) return;
  grid.dataset.cols = String(compareGridCols(n));
  grid.dataset.n = String(n);
}

function ensureVisibilityObserver() {
  if (visibilityObserver || typeof IntersectionObserver === "undefined") return;
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.cameraId;
        if (!id) continue;
        const session =
          homeSessions.get(id) ||
          compareSessions.get(id) ||
          fsWallSessions.get(id);
        if (session) session.setOffscreen(!entry.isIntersecting);
      }
    },
    { root: null, rootMargin: "48px", threshold: 0.05 }
  );
}

function observeTile(tile) {
  ensureVisibilityObserver();
  if (visibilityObserver && tile) visibilityObserver.observe(tile);
}

/**
 * @param {object} camera
 * @param {{ clickable?: boolean, selectable?: boolean, tileClass?: string }} [opts]
 */
function createTile(camera, opts = {}) {
  const { clickable = false, selectable = false, tileClass = "cam-tile" } = opts;
  const tile = document.createElement("article");
  tile.className = tileClass;
  tile.dataset.cameraId = camera.id;
  if (picked.has(camera.id)) tile.classList.add("is-picked");
  tile.tabIndex = clickable ? 0 : -1;
  if (clickable) {
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", `Open ${camera.name}`);
  }

  const stage = document.createElement("div");
  stage.className = "stage";

  const frame = document.createElement("div");
  frame.className = "frame is-down";

  const video = document.createElement("video");
  video.className = "video-js vjs-default-skin";
  video.playsInline = true;
  video.muted = true;
  video.setAttribute("playsinline", "");

  const wm = document.createElement("div");
  wm.className = "wm";
  wm.setAttribute("aria-hidden", "true");
  wm.innerHTML = `<span class="wm-site">${escapeHtml(camera.name)}</span>`;

  const liveBadge = document.createElement("div");
  liveBadge.className = "live-badge hidden";
  liveBadge.textContent = "LIVE";

  const overlay = document.createElement("div");
  overlay.className = "live-overlay";
  overlay.setAttribute("role", "status");
  const overlayMsg = document.createElement("span");
  overlayMsg.className = "live-overlay-msg";
  overlayMsg.textContent =
    camera.isStreaming === false ? "No signal" : "Connecting…";
  overlay.appendChild(overlayMsg);

  frame.appendChild(video);
  frame.appendChild(wm);
  frame.appendChild(liveBadge);
  frame.appendChild(overlay);
  stage.appendChild(frame);
  tile.appendChild(stage);

  if (selectable) {
    const pick = document.createElement("label");
    pick.className = "cam-pick";
    pick.addEventListener("click", (e) => e.stopPropagation());
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = picked.has(camera.id);
    input.setAttribute("aria-label", `Select ${camera.name}`);
    input.addEventListener("change", () => {
      if (input.checked) picked.add(camera.id);
      else picked.delete(camera.id);
      tile.classList.toggle("is-picked", input.checked);
      updateHomeSelectBar();
    });
    pick.appendChild(input);
    pick.appendChild(document.createTextNode(" Select"));
    tile.appendChild(pick);
  }

  if (clickable) {
    const open = () => switchView("watch", camera.id);
    tile.addEventListener("click", open);
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }

  return { tile, frame, video, liveBadge, overlay, overlayMsg };
}

function mountPreviewSessions(map, grid, ids, tileClass) {
  disposeMap(map);
  grid.innerHTML = "";
  ids.forEach((id) => {
    const camera = cameras.find((c) => c.id === id);
    if (!camera) return;
    const { tile, frame, video, liveBadge, overlay, overlayMsg } = createTile(
      camera,
      { clickable: false, selectable: false, tileClass }
    );
    grid.appendChild(tile);
    observeTile(tile);
    const player = videojs(video, vjsOptions({ muted: true, controls: false }));
    map.set(
      camera.id,
      new PlayerSession({
        cameraId: camera.id,
        player,
        frameEl: frame,
        overlayEl: overlay,
        overlayMsgEl: overlayMsg,
        liveBadgeEl: liveBadge,
        muted: true,
        variant: camera.hasPreview ? "preview" : "main",
      })
    );
  });
}

function selectedOrAll() {
  const allIds = cameras.map((c) => c.id);
  const selectedIds = allIds.filter((id) => picked.has(id));
  return {
    selectedIds,
    compareIds:
      selectedIds.length >= 2
        ? selectedIds
        : selectedIds.length === 0
          ? allIds
          : null,
    wallIds: selectedIds.length >= 1 ? selectedIds : allIds,
  };
}

function updateHomeSelectBar() {
  const { selectedIds, compareIds, wallIds } = selectedOrAll();
  const compareBtn = document.getElementById("compare-live-btn");
  const fsBtn = document.getElementById("fs-selected-btn");
  const meta = document.getElementById("home-select-meta");
  const clearBtn = document.getElementById("select-clear-btn");
  const allBtn = document.getElementById("select-all-btn");

  const canCompare = !!(compareIds && compareIds.length >= 2);
  const canFs = wallIds.length > 0;

  if (compareBtn) {
    compareBtn.disabled = !canCompare;
    compareBtn.title = canCompare
      ? `Compare ${compareIds.length} cameras`
      : selectedIds.length === 1
        ? "Select at least 2 cameras"
        : "Needs at least 2 cameras configured";
    compareBtn.setAttribute("aria-pressed", "false");
  }
  if (fsBtn) {
    fsBtn.disabled = !canFs;
    fsBtn.title = canFs
      ? `Fullscreen ${wallIds.length} camera${wallIds.length === 1 ? "" : "s"}`
      : "No cameras available";
  }
  if (clearBtn) {
    clearBtn.disabled = selectedIds.length === 0;
    clearBtn.title =
      selectedIds.length === 0 ? "Nothing selected" : "Clear selection";
  }
  if (allBtn) {
    const allSelected =
      cameras.length > 0 && selectedIds.length === cameras.length;
    allBtn.disabled = !cameras.length || allSelected;
    allBtn.title = allSelected
      ? "All cameras already selected"
      : "Select all cameras";
  }
  if (meta) {
    meta.textContent = selectedIds.length
      ? `${selectedIds.length} selected`
      : "Tick cameras, or use all";
  }
}

/** Size 16:9 tiles to fill the view using the shared column algorithm. */
function pickMosaicLayout(count, availW, availH, gap = 8) {
  const n = Math.max(1, count);
  const cols = compareGridCols(n);
  const rows = Math.ceil(n / cols);
  const aspect = 16 / 9;
  let tileW = (availW - gap * (cols - 1)) / cols;
  let tileH = tileW / aspect;
  const totalH = tileH * rows + gap * (rows - 1);
  if (totalH > availH) {
    tileH = (availH - gap * (rows - 1)) / rows;
    tileW = tileH * aspect;
  }
  if (tileW * cols + gap * (cols - 1) > availW) {
    tileW = (availW - gap * (cols - 1)) / cols;
    tileH = tileW / aspect;
  }
  return {
    cols,
    rows,
    tileW: Math.max(1, tileW),
    tileH: Math.max(1, tileH),
  };
}

function applyMosaicLayout(grid) {
  if (!grid || !cameras.length) return;
  const view = grid.closest(".view") || grid.parentElement;
  if (!view) return;
  const bar = view.querySelector(".compare-home-bar");
  const gap = 8;
  const availW = view.clientWidth;
  const availH = Math.max(
    120,
    view.clientHeight - (bar ? bar.offsetHeight + 10 : 0)
  );
  const { cols, rows, tileW, tileH } = pickMosaicLayout(
    cameras.length,
    availW,
    availH,
    gap
  );
  grid.style.setProperty("--grid-cols", String(cols));
  grid.style.setProperty("--grid-rows", String(rows));
  grid.style.setProperty("--tile-w", `${Math.floor(tileW)}px`);
  grid.style.setProperty("--tile-h", `${Math.floor(tileH)}px`);
  grid.style.setProperty("--grid-gap", `${gap}px`);
  grid.dataset.cols = String(cols);
}

function layoutActiveGrid() {
  if (currentViewMode === "home") {
    applyMosaicLayout(document.getElementById("home-grid"));
  }
}

function disposeWatch() {
  if (watchSession) {
    watchSession.dispose();
    watchSession = null;
  }
  const frame = document.getElementById("watch-frame");
  if (!frame) return;
  let video = document.getElementById("video-player");
  if (!video || video.classList.contains("vjs-tech")) {
    frame.querySelectorAll(".video-js, video").forEach((el) => el.remove());
    video = document.createElement("video");
    video.id = "video-player";
    video.className = "video-js vjs-default-skin";
    video.setAttribute("playsinline", "");
    video.controls = true;
    video.preload = "auto";
    const wm = document.getElementById("watch-wm");
    frame.insertBefore(video, wm);
  }
  const frameEl = document.getElementById("watch-frame");
  if (frameEl) frameEl.classList.add("is-down");
  document.getElementById("watch-live-badge")?.classList.add("hidden");
  const overlay = document.getElementById("watch-overlay");
  const msg = document.getElementById("watch-overlay-msg");
  if (overlay) overlay.classList.remove("hidden");
  if (msg) msg.textContent = "Connecting…";
}

function homeGridMatchesCameras() {
  const grid = document.getElementById("home-grid");
  if (!grid || !cameras.length) return false;
  const tiles = [...grid.querySelectorAll(".cam-tile")];
  if (tiles.length !== cameras.length) return false;
  return cameras.every((c, i) => tiles[i]?.dataset.cameraId === c.id);
}

function renderHomeGrid({ force = false } = {}) {
  const grid = document.getElementById("home-grid");
  const empty = document.getElementById("home-empty");

  if (!cameras.length) {
    disposeMap(homeSessions);
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    updateHomeSelectBar();
    syncUrl();
    return;
  }
  empty.classList.add("hidden");

  // Lighter path: resume suspended sessions on existing tiles
  if (
    !force &&
    homeSessions.size === cameras.length &&
    homeGridMatchesCameras()
  ) {
    let allOk = true;
    homeSessions.forEach((s) => {
      if (!s.player || s.player.isDisposed()) allOk = false;
    });
    if (allOk) {
      homeSessions.forEach((s) => s.resume());
      updateHomeSelectBar();
      applyMosaicLayout(grid);
      requestAnimationFrame(() => applyMosaicLayout(grid));
      syncUrl();
      return;
    }
  }

  disposeMap(homeSessions);
  grid.innerHTML = "";

  cameras.forEach((camera) => {
    const { tile, frame, video, liveBadge, overlay, overlayMsg } = createTile(
      camera,
      { clickable: true, selectable: true }
    );
    grid.appendChild(tile);
    observeTile(tile);

    const player = videojs(video, vjsOptions({ muted: true, controls: false }));
    homeSessions.set(
      camera.id,
      new PlayerSession({
        cameraId: camera.id,
        player,
        frameEl: frame,
        overlayEl: overlay,
        overlayMsgEl: overlayMsg,
        liveBadgeEl: liveBadge,
        muted: true,
        variant: camera.hasPreview ? "preview" : "main",
      })
    );
  });

  updateHomeSelectBar();
  applyMosaicLayout(grid);
  requestAnimationFrame(() => applyMosaicLayout(grid));
  syncUrl();
}

function renderCompare() {
  const grid = document.getElementById("compare-grid");
  const title = document.getElementById("compare-title");
  const ids = compareCamIds.filter((id) => cameras.some((c) => c.id === id));
  compareCamIds = ids;
  if (title) {
    title.textContent =
      ids.length >= 2
        ? `Compare live · ${ids.length} cameras`
        : "Compare live";
  }
  setCompareCols(grid, ids.length);
  mountPreviewSessions(compareSessions, grid, ids, "compare-tile");
  syncUrl();
}

function bumpFsChrome() {
  const wall = document.getElementById("fs-wall");
  const compareRoot = document.getElementById("compare-fs-root");
  wall?.classList.remove("chrome-idle");
  compareRoot?.classList.remove("chrome-idle");
  if (fsIdleTimer) clearTimeout(fsIdleTimer);
  const active =
    fsWallOpen || document.fullscreenElement === compareRoot;
  if (!active) return;
  fsIdleTimer = setTimeout(() => {
    if (fsWallOpen) wall?.classList.add("chrome-idle");
    if (document.fullscreenElement === compareRoot) {
      compareRoot.classList.add("chrome-idle");
    }
  }, FS_IDLE_MS);
}

function fsWallFocusables() {
  const wall = document.getElementById("fs-wall");
  if (!wall) return [];
  return [
    ...wall.querySelectorAll(
      'button:not([disabled]):not(.hidden), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapFsFocus(e) {
  if (!fsWallOpen || e.key !== "Tab") return;
  const list = fsWallFocusables();
  if (!list.length) {
    e.preventDefault();
    document.getElementById("fs-wall-exit-btn")?.focus();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeFsWall() {
  fsWallOpen = false;
  const wall = document.getElementById("fs-wall");
  wall?.classList.remove("chrome-idle");
  if (document.fullscreenElement === wall) {
    document.exitFullscreen().catch(() => {});
  }
  wall.classList.add("hidden");
  wall.hidden = true;
  disposeMap(fsWallSessions);
  document.getElementById("fs-wall-grid").innerHTML = "";
  if (fsFocusBefore && typeof fsFocusBefore.focus === "function") {
    try {
      fsFocusBefore.focus();
    } catch (_) {
      /* ignore */
    }
  }
  fsFocusBefore = null;
  if (currentViewMode === "home") renderHomeGrid();
}

function openFsWall(ids) {
  const list = (ids || []).filter((id) => cameras.some((c) => c.id === id));
  if (!list.length) return;

  // Suspend home decode instead of disposing — resume on exit without remount
  homeSessions.forEach((s) => s.suspend());

  fsFocusBefore = document.activeElement;
  fsWallOpen = true;
  const wall = document.getElementById("fs-wall");
  const grid = document.getElementById("fs-wall-grid");
  wall.hidden = false;
  wall.classList.remove("hidden", "chrome-idle");
  setCompareCols(grid, list.length);
  mountPreviewSessions(fsWallSessions, grid, list, "compare-tile");
  announce(`Fullscreen wall · ${list.length} cameras`);
  bumpFsChrome();

  requestAnimationFrame(() => {
    document.getElementById("fs-wall-exit-btn")?.focus();
    if (document.fullscreenElement !== wall) {
      wall.requestFullscreen().catch(() => {});
    }
  });
}

function startWatch(cameraId) {
  disposeWatch();
  currentCameraId = cameraId;
  const camera = cameras.find((c) => c.id === cameraId);
  const nameEl = document.getElementById("watch-wm-name");
  if (nameEl) nameEl.textContent = camera ? camera.name : cameraId;

  const select = document.getElementById("camera-select");
  if (select) select.value = cameraId;

  const muted = getCameraMuted(cameraId);
  const video = document.getElementById("video-player");
  const player = videojs(video, vjsOptions({ muted, controls: true }));
  watchSession = new PlayerSession({
    cameraId,
    player,
    frameEl: document.getElementById("watch-frame"),
    overlayEl: document.getElementById("watch-overlay"),
    overlayMsgEl: document.getElementById("watch-overlay-msg"),
    liveBadgeEl: document.getElementById("watch-live-badge"),
    muted,
    persistMute: true,
    variant: "main",
    onStatus: updateHeaderStatus,
  });
  syncUrl();
}

function syncUrl() {
  if (!urlSyncReady) return;
  const url = new URL(location.href);
  if (currentViewMode === "home") {
    url.searchParams.delete("view");
    url.searchParams.delete("cam");
    url.searchParams.delete("cams");
  } else if (currentViewMode === "watch" && currentCameraId) {
    url.searchParams.set("view", "watch");
    url.searchParams.set("cam", currentCameraId);
    url.searchParams.delete("cams");
  } else if (currentViewMode === "compare" && compareCamIds.length) {
    url.searchParams.set("view", "compare");
    url.searchParams.set("cams", compareCamIds.join(","));
    url.searchParams.delete("cam");
  }
  const next = url.pathname + url.search + url.hash;
  if (next !== location.pathname + location.search + location.hash) {
    history.replaceState({ view: currentViewMode }, "", next);
  }
}

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  const cam = params.get("cam");
  const cams = params.get("cams");

  if (view === "watch" && cam && cameras.some((c) => c.id === cam)) {
    switchView("watch", cam);
    return;
  }
  if (view === "compare" && cams) {
    const ids = cams
      .split(",")
      .map((s) => s.trim())
      .filter((id) => cameras.some((c) => c.id === id));
    if (ids.length >= 2) {
      compareCamIds = ids;
      switchView("compare");
      return;
    }
  }
  switchView("home");
}

/**
 * @param {"home"|"watch"|"compare"} mode
 * @param {string} [cameraId]
 */
function switchView(mode, cameraId) {
  if (mode === "watch" && !cameraId && !currentCameraId) {
    cameraId = cameras[0]?.id;
  }
  if (mode === "watch" && cameraId) currentCameraId = cameraId;

  if (currentViewMode === "home" && mode !== "home") {
    // Leaving home for watch/compare — dispose (not just suspend)
    disposeMap(homeSessions);
  }
  if (currentViewMode === "compare" && mode !== "compare") {
    disposeMap(compareSessions);
    if (document.fullscreenElement?.id === "compare-fs-root") {
      document.exitFullscreen().catch(() => {});
    }
  }
  if (currentViewMode === "watch" && mode !== "watch") disposeWatch();
  if (mode !== "home" && fsWallOpen) closeFsWall();

  currentViewMode = mode;

  document
    .getElementById("home-view")
    .classList.toggle("is-active", mode === "home");
  document
    .getElementById("watch-view")
    .classList.toggle("is-active", mode === "watch");
  document
    .getElementById("compare-view")
    .classList.toggle("is-active", mode === "compare");

  document
    .getElementById("back-home-btn")
    .classList.toggle("hidden", mode === "home");
  document
    .getElementById("watch-camera-selector")
    .classList.toggle("hidden", mode !== "watch");

  hideError();

  if (mode === "home") {
    updateHeaderStatus(
      "connected",
      `${cameras.length} camera${cameras.length === 1 ? "" : "s"}`
    );
    renderHomeGrid();
  } else if (mode === "compare") {
    updateHeaderStatus("connected", "Compare live");
    announce("Compare live");
    renderCompare();
  } else if (mode === "watch") {
    startWatch(currentCameraId);
  }
}

async function loadCameras() {
  const response = await fetch(`${API_BASE}/api/cameras`);
  if (!response.ok) throw new Error("Failed to load cameras");
  cameras = await response.json();

  const select = document.getElementById("camera-select");
  select.innerHTML = "";
  if (!cameras.length) {
    select.innerHTML = '<option value="">No cameras</option>';
    return;
  }
  cameras.forEach((camera) => {
    const option = document.createElement("option");
    option.value = camera.id;
    option.textContent = camera.name;
    select.appendChild(option);
  });
  currentCameraId = cameras[0].id;
  select.value = currentCameraId;
}

function setupEventListeners() {
  document.getElementById("back-home-btn").addEventListener("click", () => {
    switchView("home");
  });

  document.getElementById("camera-select").addEventListener("change", (e) => {
    const id = e.target.value;
    if (id && currentViewMode === "watch") switchView("watch", id);
  });

  document.getElementById("retry-btn").addEventListener("click", () => {
    if (watchSession) watchSession.retryNow();
  });

  document.getElementById("select-all-btn").addEventListener("click", () => {
    cameras.forEach((c) => picked.add(c.id));
    document.querySelectorAll("#home-grid .cam-tile").forEach((tile) => {
      tile.classList.add("is-picked");
      const input = tile.querySelector(".cam-pick input");
      if (input) input.checked = true;
    });
    updateHomeSelectBar();
    announce("All cameras selected");
  });

  document.getElementById("select-clear-btn").addEventListener("click", () => {
    picked.clear();
    document.querySelectorAll("#home-grid .cam-tile").forEach((tile) => {
      tile.classList.remove("is-picked");
      const input = tile.querySelector(".cam-pick input");
      if (input) input.checked = false;
    });
    updateHomeSelectBar();
    announce("Selection cleared");
  });

  document.getElementById("compare-live-btn").addEventListener("click", () => {
    const { compareIds } = selectedOrAll();
    if (!compareIds || compareIds.length < 2) return;
    compareCamIds = compareIds;
    switchView("compare");
  });

  document.getElementById("fs-selected-btn").addEventListener("click", () => {
    const { wallIds } = selectedOrAll();
    if (!wallIds.length) return;
    openFsWall(wallIds);
  });

  document.getElementById("fs-wall-exit-btn").addEventListener("click", () => {
    closeFsWall();
  });

  document.getElementById("fs-wall-enter-btn").addEventListener("click", () => {
    const wall = document.getElementById("fs-wall");
    if (!fsWallOpen) return;
    wall.requestFullscreen().catch(() => {});
    bumpFsChrome();
  });

  document
    .getElementById("compare-fs-all-btn")
    .addEventListener("click", () => {
      const root = document.getElementById("compare-fs-root");
      if (document.fullscreenElement === root) {
        document.exitFullscreen().catch(() => {});
      } else {
        root.requestFullscreen().catch(() => {});
        bumpFsChrome();
      }
    });

  document
    .getElementById("compare-fs-exit-btn")
    .addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    });

  const onFsActivity = () => bumpFsChrome();
  document.getElementById("fs-wall")?.addEventListener("mousemove", onFsActivity);
  document.getElementById("fs-wall")?.addEventListener("pointerdown", onFsActivity);
  document
    .getElementById("compare-fs-root")
    ?.addEventListener("mousemove", onFsActivity);
  document
    .getElementById("compare-fs-root")
    ?.addEventListener("pointerdown", onFsActivity);

  document.addEventListener("fullscreenchange", () => {
    const wall = document.getElementById("fs-wall");
    const compareRoot = document.getElementById("compare-fs-root");
    if (fsWallOpen && !document.fullscreenElement && wall && !wall.hidden) {
      document.getElementById("fs-wall-enter-btn").classList.remove("hidden");
    }
    if (fsWallOpen && document.fullscreenElement === wall) {
      document.getElementById("fs-wall-enter-btn").classList.add("hidden");
    }
    if (document.fullscreenElement === wall || document.fullscreenElement === compareRoot) {
      bumpFsChrome();
    } else {
      wall?.classList.remove("chrome-idle");
      compareRoot?.classList.remove("chrome-idle");
    }
  });

  document.addEventListener("keydown", (e) => {
    trapFsFocus(e);

    if (e.key === "Escape") {
      if (fsWallOpen && !document.fullscreenElement) {
        e.preventDefault();
        closeFsWall();
        return;
      }
      // Esc → home from watch/compare (browser FS Esc is handled by UA first)
      if (
        !document.fullscreenElement &&
        !fsWallOpen &&
        (currentViewMode === "watch" || currentViewMode === "compare")
      ) {
        e.preventDefault();
        switchView("home");
      }
    }

    if (fsWallOpen || document.fullscreenElement) bumpFsChrome();
  });
}

function updateHeaderStatus(status, message) {
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.getElementById("status-text");
  statusDot.classList.remove("connected", "disconnected", "reconnecting");

  switch (status) {
    case "connected":
    case "streaming":
      statusDot.classList.add("connected");
      break;
    case "disconnected":
    case "error":
      statusDot.classList.add("disconnected");
      break;
    default:
      statusDot.classList.add("reconnecting");
  }
  statusText.textContent = message || status;

  // Retry always available in watch (merged Refresh + Retry)
  const retryBtn = document.getElementById("retry-btn");
  if (retryBtn) {
    retryBtn.classList.toggle("hidden", currentViewMode !== "watch");
  }
}

function showError(message) {
  const el = document.getElementById("error-message");
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-message").classList.add("hidden");
}

async function refreshCameraStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/cameras`);
    if (!response.ok) return;
    const list = await response.json();
    cameras = list;
    const apply = (map) => {
      map.forEach((session, id) => {
        const cam = list.find((c) => c.id === id);
        if (!cam || session.live || session.fails > 0) return;
        const up =
          session.variant === "preview" && cam.hasPreview
            ? cam.previewStreaming
            : cam.isStreaming;
        if (up === false) session._setUi("disconnected", "No signal");
      });
    };
    if (currentViewMode === "home") apply(homeSessions);
    if (currentViewMode === "compare") apply(compareSessions);
    if (fsWallOpen) apply(fsWallSessions);
  } catch (_) {
    /* ignore */
  }
}

window.addEventListener("resize", () => {
  if (mosaicResizeTimer) clearTimeout(mosaicResizeTimer);
  mosaicResizeTimer = setTimeout(layoutActiveGrid, 100);
});

document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  loadCameras()
    .then(() => {
      urlSyncReady = true;
      applyUrlState();
      statusPollTimer = setInterval(refreshCameraStatus, 8000);
    })
    .catch((err) => {
      console.error(err);
      updateHeaderStatus("error", "Failed to load cameras");
      showError("Could not load camera list. Is the server running?");
    });
});

window.addEventListener("beforeunload", () => {
  if (statusPollTimer) clearInterval(statusPollTimer);
  if (fsIdleTimer) clearTimeout(fsIdleTimer);
  if (visibilityObserver) visibilityObserver.disconnect();
  disposeMap(homeSessions);
  disposeMap(compareSessions);
  disposeMap(fsWallSessions);
  disposeWatch();
});
