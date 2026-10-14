const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  clips: [],
  activeIndex: -1,
  voiceUrl: "",
  voiceFile: null,
  voiceDuration: 0,
  globalTime: 0,
  playing: false,
  videoFinished: false,
  exporting: false,
  draggedId: null
};

const video = $("#previewVideo");
const voice = $("#voicePreview");
const list = $("#videoList");
let toastTimer = 0;
let frameTimer = 0;
let exportRecorder = null;
let exportChunks = [];
let exportStream = null;
let exportVoiceStream = null;
let stopRequested = false;
let videoAudioContext = null;
let videoAudioSource = null;
let videoAudioGain = null;
let playbackKeepAlive = null;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const seconds = Math.floor(value);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function safeFileName(value) {
  const cleaned = String(value || "voice-video-mix").replace(/[\\/:*?"<>|]/g, "-").trim();
  return cleaned || "voice-video-mix";
}

function durationOfClips() {
  return state.clips.reduce((sum, clip) => sum + (clip.duration || 0), 0);
}

function totalDuration() {
  return state.voiceFile && state.voiceDuration > 0 ? state.voiceDuration : durationOfClips();
}

function locateTime(time) {
  let offset = Math.max(0, Number(time) || 0);
  for (let index = 0; index < state.clips.length; index++) {
    const duration = state.clips[index].duration || 0;
    if (offset < duration) return { index, offset, videoFinished: false };
    offset -= duration;
  }
  const lastIndex = state.clips.length - 1;
  return lastIndex < 0
    ? { index: -1, offset: 0, videoFinished: false }
    : { index: lastIndex, offset: state.clips[lastIndex].duration, videoFinished: true };
}

function updateClipBadge() {
  const clip = state.clips[state.activeIndex];
  $("#clipBadge").hidden = !clip;
  if (clip) {
    $("#clipNumber").textContent = String(state.activeIndex + 1).padStart(2, "0");
    $("#clipName").textContent = clip.name;
  }
}

function updatePlaybackUI() {
  const duration = totalDuration();
  const current = Math.min(state.globalTime, duration);
  $("#currentTime").textContent = formatTime(current);
  $("#totalTime").textContent = formatTime(duration);
  $("#stageClock").textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  $("#seekBar").value = duration ? String(Math.round(current / duration * 1000)) : "0";
  $("#playPause").textContent = state.playing ? "Ⅱ" : "▶";
  $("#playPause").setAttribute("aria-label", state.playing ? "Tạm dừng" : "Phát");
  $("#playPause").disabled = !state.clips.length || state.exporting;
  $("#restart").disabled = !state.clips.length || state.exporting;
  $("#seekBar").disabled = !state.clips.length || state.exporting;
}

function render() {
  list.innerHTML = state.clips.map((clip, index) => `
    <div class="video-row ${index === state.activeIndex ? "selected" : ""}" data-clip="${clip.id}" draggable="true" tabindex="0">
      <span class="drag-handle" title="Kéo để đổi thứ tự" aria-label="Kéo để đổi thứ tự">≡</span>
      <span class="clip-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="clip-copy"><strong title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</strong><small>${formatTime(clip.duration)} · ${escapeHtml(clip.type || "Video")}</small></span>
      <span class="clip-actions">
        <button type="button" data-move="-1" aria-label="Đưa clip lên" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-move="1" aria-label="Đưa clip xuống" ${index === state.clips.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="delete-clip" data-remove aria-label="Xóa ${escapeHtml(clip.name)}">×</button>
      </span>
    </div>`).join("");
  $("#emptyList").hidden = state.clips.length > 0;
  $("#stageEmpty").hidden = state.clips.length > 0;
  $("#videoSummary").textContent = `${state.clips.length} clip · ${formatTime(durationOfClips())}`;
  $("#infoVideoCount").textContent = `${state.clips.length} clip`;
  $("#infoVoice").textContent = state.voiceFile ? state.voiceFile.name : "Chưa thêm";
  $("#infoDuration").textContent = formatTime(totalDuration());
  const difference = state.voiceDuration - durationOfClips();
  $("#lengthHint").textContent = !state.voiceFile || !state.clips.length
    ? "Thời lượng voice quyết định độ dài video xuất."
    : difference < -0.5
      ? `Video xuất theo voice; ${formatTime(Math.abs(difference))} cuối của chuỗi clip sẽ bị cắt.`
      : difference > 0.5
        ? `Video ngắn hơn voice ${formatTime(difference)}; giữ khung hình cuối đến khi voice hết.`
        : "Thời lượng voice và chuỗi video gần khớp nhau.";
  $("#exportVideo").disabled = !state.clips.length || !state.voiceFile || state.exporting;
  $("#exportVideoSide").disabled = !state.clips.length || !state.voiceFile || state.exporting;
  $("#voiceLoaded").hidden = !state.voiceFile;
  $("#voiceName").textContent = state.voiceFile ? "Thay file voice" : "Chọn file voice";
  if (state.voiceFile) {
    $("#voiceLoadedName").textContent = state.voiceFile.name;
    $("#voiceDuration").textContent = formatTime(state.voiceDuration);
  }
  updateClipBadge();
  updatePlaybackUI();
  renderVideoRows();
}

function renderVideoRows() {
  $$(".video-row", list).forEach(row => {
    row.addEventListener("click", event => {
      const clip = state.clips.find(item => item.id === row.dataset.clip);
      if (!clip) return;
      if (event.target.closest("[data-remove]")) {
        removeClip(row.dataset.clip);
        return;
      }
      const move = event.target.closest("[data-move]");
      if (move) {
        moveClip(row.dataset.clip, Number(move.dataset.move));
        return;
      }
      selectClip(state.clips.indexOf(clip), true);
    });
    row.addEventListener("dragstart", event => {
      state.draggedId = row.dataset.clip;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.draggedId);
    });
    row.addEventListener("dragend", () => {
      state.draggedId = null;
      $$(".video-row", list).forEach(item => item.classList.remove("dragging", "drop-target"));
    });
    row.addEventListener("dragover", event => {
      event.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", event => {
      event.preventDefault();
      const from = state.clips.findIndex(item => item.id === (state.draggedId || event.dataTransfer.getData("text/plain")));
      const to = state.clips.findIndex(item => item.id === row.dataset.clip);
      if (from >= 0 && to >= 0 && from !== to) reorderClip(from, to);
    });
    row.addEventListener("keydown", event => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        moveClip(row.dataset.clip, event.key === "ArrowUp" ? -1 : 1);
      }
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function loadVideoSource(clip, offset = 0) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      video.currentTime = Math.min(offset, Math.max(0, video.duration - 0.05));
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error(`Không đọc được video “${clip.name}”. Hãy thử MP4 (H.264) hoặc WebM.`));
    };
    video.pause();
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.src = clip.url;
    video.load();
  });
}

async function addVideos(files) {
  const accepted = [...files].filter(file => file.type === "video/mp4" || file.type === "video/webm" || /\.(mp4|webm)$/i.test(file.name));
  if (!accepted.length) {
    notify("Chọn file MP4 hoặc WebM để thêm vào timeline.");
    return;
  }
  const loaded = await Promise.all(accepted.map(file => new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve({
        id: crypto.randomUUID(),
        file,
        url,
        name: file.name.replace(/\.[^.]+$/, ""),
        type: file.type === "video/webm" || /\.webm$/i.test(file.name) ? "WebM" : "MP4",
        duration: Number.isFinite(probe.duration) ? probe.duration : 0
      });
    };
    probe.onerror = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve(null);
    };
    const timeout = setTimeout(() => {
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(null);
    }, 15000);
    probe.src = url;
  })));
  const valid = loaded.filter(clip => {
    if (clip?.duration > 0) return true;
    if (clip) URL.revokeObjectURL(clip.url);
    return false;
  });
  state.clips.push(...valid);
  if (!valid.length) {
    notify("Không mở được video. Hãy thử MP4 (H.264) hoặc WebM.");
    return;
  }
  if (state.activeIndex < 0) {
    state.activeIndex = 0;
    await loadVideoSource(state.clips[0]);
  }
  render();
  const skipped = accepted.length - valid.length;
  notify(`Đã thêm ${valid.length} video vào timeline.${skipped ? ` Bỏ qua ${skipped} file không mở được.` : ""}`);
}

function selectClip(index, playAfter = false) {
  if (index < 0 || index >= state.clips.length) return;
  const wasPlaying = state.playing || playAfter;
  state.activeIndex = index;
  state.globalTime = state.clips.slice(0, index).reduce((sum, clip) => sum + clip.duration, 0);
  loadVideoSource(state.clips[index]).then(() => {
    syncVoiceToTimeline();
    if (wasPlaying) startPlayback();
  }).catch(error => notify(error.message));
  render();
}

function moveClip(id, offset) {
  const index = state.clips.findIndex(clip => clip.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= state.clips.length) return;
  reorderClip(index, target);
}

function reorderClip(from, to) {
  if (from < 0 || to < 0 || from >= state.clips.length || to >= state.clips.length || !state.clips[from]) return;
  const activeId = state.clips[state.activeIndex]?.id;
  const [clip] = state.clips.splice(from, 1);
  if (!clip) return;
  state.clips.splice(to, 0, clip);
  state.activeIndex = activeId ? state.clips.findIndex(item => item?.id === activeId) : to;
  if (state.activeIndex < 0) state.activeIndex = to;
  state.globalTime = state.clips.slice(0, state.activeIndex).reduce((sum, item) => sum + item.duration, 0) + (video.currentTime || 0);
  render();
}

function removeClip(id) {
  const index = state.clips.findIndex(clip => clip.id === id);
  if (index < 0) return;
  const activeId = state.clips[state.activeIndex]?.id;
  const [removed] = state.clips.splice(index, 1);
  URL.revokeObjectURL(removed.url);
  if (!state.clips.length) {
    state.activeIndex = -1;
    state.globalTime = 0;
    state.videoFinished = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    state.playing = false;
  } else {
    const next = activeId === id
      ? Math.min(index, state.clips.length - 1)
      : Math.max(0, state.clips.findIndex(clip => clip.id === activeId));
    selectClip(next);
  }
  render();
}

function setVoice(file) {
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = URL.createObjectURL(file);
  state.voiceFile = file;
  voice.pause();
  voice.src = state.voiceUrl;
  voice.load();
  voice.onloadedmetadata = () => {
    state.voiceDuration = Number.isFinite(voice.duration) ? voice.duration : 0;
    render();
    notify(`Đã nạp voice · ${formatTime(state.voiceDuration)}.`);
  };
  voice.onerror = () => notify("Không đọc được file voice. Hãy thử MP3 hoặc WAV.");
  render();
}

function syncVoiceToTimeline() {
  const time = Math.min(state.globalTime, state.voiceDuration || state.globalTime);
  if (Math.abs(voice.currentTime - time) > 0.25) voice.currentTime = time;
  voice.volume = Number($("#voiceVolume").value) / 100;
  if ((state.playing || state.exporting) && state.voiceFile && time < state.voiceDuration) {
    voice.play().catch(() => notify("Không thể phát file voice này."));
  } else {
    voice.pause();
  }
}

async function seekGlobal(time, resume = false) {
  if (!state.clips.length) return;
  const bounded = Math.max(0, Math.min(Number(time) || 0, totalDuration()));
  const located = locateTime(bounded);
  const index = located.index;
  const offset = located.offset;
  const videoFinished = located.videoFinished || Boolean(state.voiceFile && bounded >= state.voiceDuration);
  if (index < 0) return;
  const needsLoad = index !== state.activeIndex || video.currentSrc !== state.clips[index].url;
  state.activeIndex = index;
  state.globalTime = bounded;
  state.videoFinished = videoFinished;
  if (needsLoad) await loadVideoSource(state.clips[index], offset);
  else video.currentTime = Math.min(offset, Math.max(0, video.duration - 0.05));
  state.globalTime = bounded;
  if (videoFinished) video.pause();
  if (resume) {
    state.playing = true;
    if (!videoFinished) await video.play();
  } else {
    video.pause();
    state.playing = false;
  }
  syncVoiceToTimeline();
  updateClipBadge();
  updatePlaybackUI();
  renderVideoRows();
}

function startPlayback() {
  if (!state.clips.length) return;
  if (state.globalTime >= totalDuration()) {
    seekGlobal(0, true).catch(error => notify(error.message || "Không thể phát video."));
    return;
  }
  state.playing = true;
  state.videoFinished = locateTime(state.globalTime).videoFinished;
  if (state.videoFinished) {
    syncVoiceToTimeline();
    updatePlaybackUI();
    return;
  }
  video.play().then(() => {
    syncVoiceToTimeline();
    updatePlaybackUI();
  }).catch(() => {
    state.playing = false;
    updatePlaybackUI();
    notify("Không thể phát video này trong trình duyệt.");
  });
}

function stopPlayback() {
  state.playing = false;
  video.pause();
  voice.pause();
  updatePlaybackUI();
}

function onVideoTimeUpdate() {
  if (state.activeIndex < 0 || state.videoFinished) return;
  state.globalTime = state.clips.slice(0, state.activeIndex).reduce((sum, clip) => sum + clip.duration, 0) + video.currentTime;
  if (state.playing && state.voiceFile && Math.abs(voice.currentTime - state.globalTime) > 0.8 && state.globalTime < state.voiceDuration) {
    voice.currentTime = state.globalTime;
  }
  updatePlaybackUI();
}

function onVoiceTimeUpdate() {
  if (!state.voiceFile || (!state.playing && !state.exporting)) return;
  state.globalTime = Math.min(voice.currentTime, totalDuration());
  updatePlaybackUI();
}

function onVoiceEnded() {
  if (!state.playing && !state.exporting) return;
  state.globalTime = totalDuration();
  state.videoFinished = true;
  if (state.exporting) {
    stopRequested = true;
    video.pause();
  } else {
    stopPlayback();
  }
  updatePlaybackUI();
}

async function handleClipEnded() {
  if (!state.playing || state.exporting) return;
  const nextIndex = state.activeIndex + 1;
  if (nextIndex >= state.clips.length) {
    state.globalTime = durationOfClips();
    state.videoFinished = true;
    if (!state.voiceFile || state.voiceDuration <= durationOfClips()) {
      state.globalTime = totalDuration();
      stopPlayback();
    } else {
      video.pause();
      syncVoiceToTimeline();
      updatePlaybackUI();
    }
    return;
  }
  state.activeIndex = nextIndex;
  state.globalTime = state.clips.slice(0, nextIndex).reduce((sum, clip) => sum + clip.duration, 0);
  updateClipBadge();
  renderVideoRows();
  try {
    await loadVideoSource(state.clips[nextIndex]);
    if (state.playing) await video.play();
  } catch (error) {
    stopPlayback();
    notify(error.message);
  }
}

function drawVideoFrame(context, canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const radius = 26;
  const videoX = 30;
  const videoY = 28;
  const videoWidth = width - 60;
  const videoHeight = height - 56;
  const current = state.clips[state.activeIndex];
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#202329");
  gradient.addColorStop(.52, "#111318");
  gradient.addColorStop(1, "#282117");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.save();
  roundedRect(context, videoX, videoY, videoWidth, videoHeight, radius);
  context.clip();
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
    const scale = Math.min(videoWidth / video.videoWidth, videoHeight / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    context.drawImage(video, videoX + (videoWidth - drawWidth) / 2, videoY + (videoHeight - drawHeight) / 2, drawWidth, drawHeight);
  }
  context.restore();
  roundedRect(context, videoX + 1, videoY + 1, videoWidth - 2, videoHeight - 2, radius - 1);
  context.strokeStyle = "#e3c17f8c";
  context.lineWidth = 2;
  context.stroke();

  const shade = context.createLinearGradient(0, height * .69, 0, height);
  shade.addColorStop(0, "#090a0d00");
  shade.addColorStop(1, "#090a0de8");
  context.fillStyle = shade;
  context.fillRect(videoX, height * .68, videoWidth, height * .32);
  context.textAlign = "left";
  context.fillStyle = "#f1d59c";
  context.font = "600 16px Arial";
  context.fillText(`CLIP ${String(Math.max(0, state.activeIndex) + 1).padStart(2, "0")} / ${String(state.clips.length).padStart(2, "0")}`, 58, height - 54);
  context.fillStyle = "#ffffff";
  context.font = "500 21px Arial";
  context.fillText(current?.name || "VOICE + VIDEO", 58, height - 25, width - 116);
  context.fillStyle = "#ffffffb5";
  context.textAlign = "right";
  context.font = "500 16px Arial";
  context.fillText(formatTime(state.globalTime), width - 58, height - 25);
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function setExportProgress(value, label) {
  const percent = Math.max(0, Math.min(100, value));
  $("#exportProgress").hidden = false;
  $("#exportStatus").textContent = label;
  $("#exportPercent").textContent = `${Math.round(percent)}%`;
  $("#progressFill").style.width = `${percent}%`;
}

function stopCanvasFrames() {
  clearInterval(frameTimer);
  frameTimer = 0;
}

function cleanupExport() {
  stopCanvasFrames();
  if (playbackKeepAlive) {
    playbackKeepAlive.stop();
    playbackKeepAlive = null;
  }
  exportStream?.getTracks().forEach(track => track.stop());
  exportVoiceStream?.getTracks().forEach(track => track.stop());
  exportStream = null;
  exportVoiceStream = null;
  state.exporting = false;
  render();
}

async function keepVideoPlaybackActive() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    video.muted = false;
    video.volume = 0.005;
    return;
  }
  if (!videoAudioContext) {
    videoAudioContext = new AudioContextClass();
    videoAudioSource = videoAudioContext.createMediaElementSource(video);
    videoAudioGain = videoAudioContext.createGain();
    videoAudioGain.gain.value = 0.00001;
    videoAudioSource.connect(videoAudioGain);
    videoAudioGain.connect(videoAudioContext.destination);
  }
  if (videoAudioContext.state !== "running") await videoAudioContext.resume();
  const oscillator = videoAudioContext.createOscillator();
  const keepAliveGain = videoAudioContext.createGain();
  keepAliveGain.gain.value = 0.00001;
  oscillator.connect(keepAliveGain);
  keepAliveGain.connect(videoAudioContext.destination);
  oscillator.start();
  playbackKeepAlive = oscillator;
  video.muted = false;
  video.volume = 1;
}

async function exportVideo() {
  if (state.exporting) return;
  if (!state.clips.length) return notify("Thêm ít nhất một video trước khi xuất.");
  if (!state.voiceFile) return notify("Thêm file voice để ghép vào video.");
  const capture = voice.captureStream || voice.mozCaptureStream;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !capture) {
    return notify("Xuất video cần Chrome hoặc Edge mới.");
  }
  const button = $("#exportVideoSide");
  const oldTime = state.globalTime;
  const oldIndex = state.activeIndex;
  state.exporting = true;
  state.playing = false;
  stopRequested = false;
  render();
  voice.pause();
  video.pause();
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) {
    state.exporting = false;
    render();
    return notify("Không thể tạo khung hình video trên trình duyệt này.");
  }
  try {
    await loadVideoSource(state.clips[0]);
    voice.currentTime = 0;
    voice.volume = Number($("#voiceVolume").value) / 100;
    await new Promise((resolve, reject) => {
      if (voice.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
      const timeout = setTimeout(() => {
        voice.removeEventListener("canplay", ready);
        reject(new Error("Không nạp được file voice. Kiểm tra file rồi thử lại."));
      }, 15000);
      const ready = () => {
        clearTimeout(timeout);
        resolve();
      };
      voice.addEventListener("canplay", ready, { once: true });
    });
    exportStream = canvas.captureStream(30);
    exportVoiceStream = capture.call(voice);
    const voiceTracks = exportVoiceStream.getAudioTracks();
    if (!voiceTracks.length) throw new Error("Không lấy được luồng âm thanh từ file voice.");
    voiceTracks.forEach(track => exportStream.addTrack(track));
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("Trình duyệt không hỗ trợ xuất định dạng WebM.");
    await keepVideoPlaybackActive();
    exportChunks = [];
    exportRecorder = new MediaRecorder(exportStream, { mimeType });
    exportRecorder.ondataavailable = event => {
      if (event.data.size) exportChunks.push(event.data);
    };
    exportRecorder.onerror = event => {
      stopRequested = true;
      notify(event.error?.message || "Có lỗi khi ghi video.");
    };
    exportRecorder.start(1000);
    state.activeIndex = 0;
    state.globalTime = 0;
    render();
    drawVideoFrame(context, canvas);
    frameTimer = setInterval(() => {
      drawVideoFrame(context, canvas);
      const duration = totalDuration();
      state.globalTime = Math.min(voice.currentTime, duration);
      const progress = duration ? Math.min(100, state.globalTime / duration * 100) : 0;
      setExportProgress(progress, `Đang xuất clip ${Math.max(1, state.activeIndex + 1)}/${state.clips.length}…`);
    }, 1000 / 30);
    voice.currentTime = 0;
    try {
      await voice.play();
    } catch {
      throw new Error("Không thể phát file voice trong lúc xuất. Hãy chọn lại file rồi thử.");
    }
    for (let index = 0; index < state.clips.length && !stopRequested; index++) {
      state.activeIndex = index;
      state.globalTime = state.clips.slice(0, index).reduce((sum, clip) => sum + clip.duration, 0);
      if (index > 0) await loadVideoSource(state.clips[index]);
      video.muted = false;
      await video.play();
      render();
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener("ended", ended);
          video.removeEventListener("error", failed);
          voice.removeEventListener("ended", audioEnded);
        };
        const ended = () => {
          cleanup();
          resolve();
        };
        const audioEnded = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error(`Video “${state.clips[index].name}” bị lỗi trong lúc xuất.`));
        };
        video.addEventListener("ended", ended, { once: true });
        video.addEventListener("error", failed, { once: true });
        voice.addEventListener("ended", audioEnded, { once: true });
        if (stopRequested) {
          cleanup();
          resolve();
        }
      });
      state.globalTime = state.clips.slice(0, index + 1).reduce((sum, clip) => sum + clip.duration, 0);
    }
    if (!voice.ended && voice.currentTime < totalDuration()) {
      await new Promise(resolve => voice.addEventListener("ended", resolve, { once: true }));
    }
    voice.pause();
    stopCanvasFrames();
    if (exportRecorder.state !== "inactive") {
      exportRecorder.requestData();
      await new Promise(resolve => {
        exportRecorder.addEventListener("stop", resolve, { once: true });
        exportRecorder.stop();
      });
    }
    const blob = new Blob(exportChunks, { type: mimeType });
    if (!blob.size) throw new Error("Video xuất ra bị rỗng. Hãy thử lại bằng Chrome hoặc Edge.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName($("#projectTitle").value)}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setExportProgress(100, "Xuất video hoàn tất.");
    notify("Đã xuất video voice + video thành công.");
  } catch (error) {
    stopRequested = true;
    if (exportRecorder?.state !== "inactive") {
      await new Promise(resolve => {
        exportRecorder.addEventListener("stop", resolve, { once: true });
        exportRecorder.stop();
      });
    }
    notify(error.message || "Không thể xuất video.");
  } finally {
    voice.pause();
    video.pause();
    video.muted = true;
    cleanupExport();
    if (state.clips.length) {
      state.activeIndex = Math.max(0, Math.min(oldIndex, state.clips.length - 1));
      try {
        await seekGlobal(Math.min(oldTime, totalDuration()), false);
      } catch (error) {
        state.activeIndex = Math.max(0, Math.min(oldIndex, state.clips.length - 1));
        notify(`Đã xuất video nhưng không khôi phục được vị trí xem trước: ${error.message}`);
      }
    }
    render();
    if (button) button.blur();
  }
}

function init() {
  video.muted = true;
  render();
  $("#addVideos").addEventListener("click", () => $("#videoFiles").click());
  $("#videoFiles").addEventListener("change", event => {
    addVideos(event.target.files);
    event.target.value = "";
  });
  $("#addVoice").addEventListener("click", () => $("#voiceFile").click());
  $("#voiceFile").addEventListener("change", event => {
    if (event.target.files?.[0]) setVoice(event.target.files[0]);
    event.target.value = "";
  });
  $("#removeVoice").addEventListener("click", () => {
    voice.pause();
    voice.removeAttribute("src");
    voice.load();
    if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
    state.voiceUrl = "";
    state.voiceFile = null;
    state.voiceDuration = 0;
    render();
  });
  $("#voiceVolume").addEventListener("input", event => {
    voice.volume = Number(event.target.value) / 100;
    $("#voiceVolumeValue").textContent = `${event.target.value}%`;
  });
  $("#playPause").addEventListener("click", () => state.playing ? stopPlayback() : startPlayback());
  $("#restart").addEventListener("click", () => seekGlobal(0, false));
  $("#seekBar").addEventListener("input", event => {
    const wasPlaying = state.playing;
    seekGlobal(totalDuration() * Number(event.target.value) / 1000, wasPlaying);
  });
  $("#previewStage").addEventListener("click", event => {
    if (event.target.closest(".clip-badge")) return;
    state.playing ? stopPlayback() : startPlayback();
  });
  video.addEventListener("timeupdate", onVideoTimeUpdate);
  video.addEventListener("ended", handleClipEnded);
  voice.addEventListener("timeupdate", onVoiceTimeUpdate);
  voice.addEventListener("ended", onVoiceEnded);
  video.addEventListener("loadedmetadata", () => {
    $("#stageEmpty").hidden = true;
    updateClipBadge();
  });
  $("#exportVideo").addEventListener("click", exportVideo);
  $("#exportVideoSide").addEventListener("click", exportVideo);
  $("#mobileMenu").addEventListener("click", () => $(".top-actions").classList.toggle("open"));
  window.addEventListener("beforeunload", () => {
    state.clips.forEach(clip => URL.revokeObjectURL(clip.url));
    if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  });
}

init();
