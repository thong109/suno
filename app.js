const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  tracks: [],
  selected: -1,
  activeTab: "playlist",
  autoNext: true,
  channel: "AurioMusic",
  showChannel: true,
  showSubtitle: true,
  showTitle: true,
  showNote: true,
  subtitleLines: [],
  subtitleMarks: [],
  images: {},
  scenes: [],
  settings: {
    playlistName: "AurioMusic — Rock Ballad",
    artist: "Ca sĩ giấu mặt",
    album: "COVER ROCK BALLAD",
    title: "Tên bài hát",
    noteText: "",
    subtitleSize: 44,
    subtitlePosition: 76,
    titleSize: 64,
    titlePosition: 24,
    layout: "vinyl",
    waveColor: "#edb969",
    waveType: "bars",
    waveAmplitude: 70,
    waveSensitivity: 100,
    wavePosition: 92,
    waveGlow: true,
    darkness: 30
  }
};

const audio = $("#audioPlayer");
const panels = $("#panelContent");
let toastTimer;
let imageUrls = {};
let exportAudioContext = null;
let exportAudioSource = null;
let audioAnalyser = null;
let frequencyData = null;
let exportInProgress = false;
let waveAnimationFrame = 0;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function currentTrack() { return state.tracks[state.selected] || null; }

function syncPreviewLayout() {
  const backgroundLayout = state.settings.layout === "background";
  $("#musicScene").style.display = backgroundLayout ? "none" : "flex";
  $("#floatingTitle").hidden = !backgroundLayout || !state.showTitle;
  $("#previewNote").hidden = !backgroundLayout || !state.showNote;
}

function renderTrackList() {
  const list = $("#trackList", panels);
  if (!list) return;
  list.innerHTML = state.tracks.length ? state.tracks.map((track, index) => `
    <div class="track-item ${index === state.selected ? "selected" : ""}" data-track="${index}" tabindex="0">
      <span class="track-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="track-info"><strong>${escapeHtml(track.title)}</strong><small>${formatTime(track.duration)} · ${escapeHtml(track.artist || "Chưa rõ nghệ sĩ")}</small></span>
      <button class="track-remove" data-remove="${index}" aria-label="Xóa ${escapeHtml(track.title)}">×</button>
    </div>`).join("") : `<div class="empty-state">Playlist đang trống. Thêm nhạc để bắt đầu dựng video.</div>`;
  const count = state.tracks.length;
  const duration = state.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const meta = $("#playlistMeta", panels);
  if (meta) meta.textContent = `${count} bài · ${formatTime(duration)}`;
  $$(".track-item", list).forEach(item => {
    const select = () => selectTrack(Number(item.dataset.track));
    item.addEventListener("click", event => {
      if (event.target.closest("[data-remove]")) return;
      select();
    });
    item.addEventListener("keydown", event => { if (event.key === "Enter") select(); });
  });
  $$("[data-remove]", list).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    removeTrack(Number(button.dataset.remove));
  }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function updateTrackUI() {
  const track = currentTrack();
  $("#timelineTrackName").textContent = track?.title || "Chưa chọn nhạc";
  $("#totalTime").textContent = formatTime(track?.duration || audio.duration);
  $("#timelineEnd").textContent = formatTime(state.tracks.reduce((sum, item) => sum + (item.duration || 0), 0));
  $("#previewTitle").textContent = track?.title || state.settings.title || "Tên bài hát";
  $("#floatingTitle").textContent = track?.title || state.settings.title || "Tên bài hát";
  $("#previewArtist").textContent = track?.artist || state.settings.artist;
  $("#previewAlbum").textContent = track?.album || state.settings.album;
  $("#recordLabel").textContent = state.channel || "AurioMusic";
  $("#previewTrackCaption").textContent = `${state.channel || "AURIO"}  ·  MUSIC`;
  $("#channelWatermark").textContent = state.channel || "AurioMusic";
  $("#channelWatermark").hidden = !state.showChannel;
  $("#previewTitle").hidden = !state.showTitle;
  const activeMark = [...state.subtitleMarks].reverse().find(mark => mark.time <= audio.currentTime);
  $("#subtitlePreview").textContent = activeMark?.text || state.subtitleLines[0] || "";
  $("#subtitlePreview").hidden = !state.showSubtitle || !state.subtitleLines.length;
  const bar = $("#seekBar");
  bar.value = audio.duration ? String(Math.round((audio.currentTime / audio.duration) * 100)) : "0";
  $("#currentTime").textContent = formatTime(audio.currentTime);
  syncPreviewLayout();
}

function ensureAudioAnalyser() {
  if (!exportAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Trình duyệt này chưa hỗ trợ phân tích âm thanh.");
    exportAudioContext = new AudioContextClass();
    exportAudioSource = exportAudioContext.createMediaElementSource(audio);
    audioAnalyser = exportAudioContext.createAnalyser();
    audioAnalyser.fftSize = 2048;
    audioAnalyser.smoothingTimeConstant = 0.78;
    frequencyData = new Uint8Array(audioAnalyser.frequencyBinCount);
    exportAudioSource.connect(audioAnalyser);
    audioAnalyser.connect(exportAudioContext.destination);
  }
  return exportAudioContext;
}

function getWaveLevels(count) {
  const levels = new Float32Array(count);
  if (audioAnalyser && frequencyData) {
    audioAnalyser.getByteFrequencyData(frequencyData);
    const sensitivity = Number(state.settings.waveSensitivity ?? 100) / 100;
    const binCount = frequencyData.length;
    for (let index = 0; index < count; index++) {
      const start = Math.floor((index / count) ** 1.65 * binCount);
      const end = Math.max(start + 1, Math.floor(((index + 1) / count) ** 1.65 * binCount));
      let total = 0;
      for (let bin = start; bin < Math.min(end, binCount); bin++) total += frequencyData[bin];
      const magnitude = total / Math.max(1, Math.min(end, binCount) - start) / 255;
      levels[index] = Math.min(1, magnitude * sensitivity * 2.1);
    }
  }
  if (audio.paused) {
    for (let index = 0; index < count; index++) {
      levels[index] = Math.max(levels[index], 0.045 + Math.abs(Math.sin(index * 0.51)) * 0.035);
    }
  }
  return levels;
}

function drawWave(context, width, height) {
  const mode = state.settings.waveType || "bars";
  if (mode === "off") return;
  const count = mode === "ring" ? 72 : 96;
  const levels = getWaveLevels(count);
  const color = state.settings.waveColor || "#edb969";
  const amplitude = Number(state.settings.waveAmplitude ?? 70) / 100;
  const yPosition = Number(state.settings.wavePosition ?? 92) / 100;
  const baseline = height * yPosition;
  const lineWidth = Math.max(1.5, width / 640);
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalAlpha = 0.88;
  if (state.settings.waveGlow !== false) {
    context.shadowColor = color;
    context.shadowBlur = Math.min(18, width / 60);
  }

  if (mode === "bars" || mode === "mirror") {
    const left = width * 0.15;
    const span = width * 0.7;
    const gap = Math.max(1, span / count * 0.25);
    const barWidth = Math.max(1, (span - gap * (count - 1)) / count);
    const maxHeight = height * 0.17 * amplitude;
    levels.forEach((level, index) => {
      const x = left + index * (barWidth + gap);
      const barHeight = Math.max(2, level * maxHeight);
      if (mode === "mirror") {
        context.fillRect(x, baseline - barHeight, barWidth, barHeight);
        context.fillRect(x, baseline + 2, barWidth, barHeight);
      } else {
        context.fillRect(x, baseline - barHeight, barWidth, barHeight);
      }
    });
  } else if (mode === "line" || mode === "soft") {
    const left = width * 0.1;
    const span = width * 0.8;
    const maxHeight = height * 0.16 * amplitude;
    context.beginPath();
    levels.forEach((level, index) => {
      const x = left + span * index / (count - 1);
      const y = baseline - level * maxHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    if (mode === "soft") {
      context.lineTo(left + span, baseline);
      context.lineTo(left, baseline);
      context.closePath();
      const gradient = context.createLinearGradient(0, baseline - maxHeight, 0, baseline + 3);
      gradient.addColorStop(0, `${color}aa`);
      gradient.addColorStop(1, `${color}00`);
      context.fillStyle = gradient;
      context.fill();
      context.strokeStyle = color;
      context.beginPath();
      levels.forEach((level, index) => {
        const x = left + span * index / (count - 1);
        const y = baseline - level * maxHeight;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
    }
    context.stroke();
  } else if (mode === "particles") {
    const left = width * 0.1;
    const span = width * 0.8;
    const maxHeight = height * 0.2 * amplitude;
    levels.forEach((level, index) => {
      const x = left + span * index / (count - 1);
      const y = baseline - level * maxHeight;
      context.globalAlpha = 0.35 + level * 0.65;
      context.beginPath();
      context.arc(x, y, Math.max(1.2, lineWidth * (0.8 + level * 1.5)), 0, Math.PI * 2);
      context.fill();
    });
  } else if (mode === "ring") {
    const centerX = width * 0.5;
    const radius = Math.min(width * 0.2, height * 0.35);
    const maxLength = radius * 0.22 * amplitude;
    const centerY = Math.min(
      height - radius - maxLength,
      Math.max(radius + maxLength, height * yPosition)
    );
    levels.forEach((level, index) => {
      const angle = index / count * Math.PI * 2 - Math.PI / 2;
      const innerRadius = radius;
      const outerRadius = radius + Math.max(2, level * maxLength);
      context.beginPath();
      context.moveTo(centerX + Math.cos(angle) * innerRadius, centerY + Math.sin(angle) * innerRadius);
      context.lineTo(centerX + Math.cos(angle) * outerRadius, centerY + Math.sin(angle) * outerRadius);
      context.stroke();
    });
  }
  context.restore();
}

function applyWaveSettings() {
  const canvas = $("#soundWave");
  if (!canvas) return;
  canvas.hidden = state.settings.waveType === "off";
  canvas.dataset.mode = state.settings.waveType || "bars";
  canvas.style.opacity = state.settings.waveGlow === false ? "0.72" : "1";
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const canvasWidth = Math.max(1, Math.round(rect.width * pixelRatio));
  const canvasHeight = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawWave(context, canvas.width, canvas.height);
}

function animateWave() {
  cancelAnimationFrame(waveAnimationFrame);
  const canvas = $("#soundWave");
  if (!canvas || canvas.hidden || audio.paused) {
    applyWaveSettings();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  drawWave(context, width, height);
  waveAnimationFrame = requestAnimationFrame(animateWave);
}

function selectTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;
  const wasPlaying = !audio.paused;
  audio.pause();
  state.selected = index;
  const track = currentTrack();
  state.subtitleLines = Array.isArray(track.lyrics) ? track.lyrics : (index === 0 ? state.subtitleLines : []);
  state.subtitleMarks = Array.isArray(track.lyricMarks) ? track.lyricMarks : (index === 0 ? state.subtitleMarks : []);
  audio.src = track.url;
  audio.load();
  $("#artistInput") && ($("#artistInput").value = track.artist || state.settings.artist);
  $("#albumInput") && ($("#albumInput").value = track.album || state.settings.album);
  $("#previewFrame").style.backgroundImage = track.cover ? `url("${track.cover}")` : "";
  updateTrackUI();
  renderTrackList();
  if (wasPlaying) audio.play().catch(() => notify("Không thể phát tệp âm thanh này."));
}

function removeTrack(index) {
  const track = state.tracks[index];
  if (!track) return;
  URL.revokeObjectURL(track.url);
  state.tracks.splice(index, 1);
  if (!state.tracks.length) {
    state.selected = -1;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } else {
    const next = Math.min(index, state.tracks.length - 1);
    if (index <= state.selected) state.selected = Math.max(0, state.selected - 1);
    selectTrack(next);
  }
  renderTrackList();
  updateTrackUI();
}

async function addTracks(files) {
  const audioFiles = [...files].filter(file => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac)$/i.test(file.name));
  if (!audioFiles.length) return;
  const added = await Promise.all(audioFiles.map(file => new Promise(resolve => {
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () => resolve({ file, duration: Number.isFinite(probe.duration) ? probe.duration : 0 });
    probe.onerror = () => resolve({ file, duration: 0 });
    probe.src = URL.createObjectURL(file);
  })));
  let linked = 0;
  added.forEach(({ file, duration }) => {
    const title = file.name.replace(/\.[^.]+$/, "");
    const savedTrack = state.tracks.find(track => !track.url && (track.fileName === file.name || track.title === title));
    if (savedTrack) {
      savedTrack.url = URL.createObjectURL(file);
      savedTrack.file = file;
      savedTrack.fileName = file.name;
      savedTrack.duration = duration;
      linked++;
      return;
    }
    state.tracks.push({
      title,
      fileName: file.name,
      artist: state.settings.artist,
      album: state.settings.album,
      lyrics: [],
      lyricMarks: [],
      duration,
      url: URL.createObjectURL(file),
      file
    });
  });
  if (state.selected < 0 && state.tracks.length) state.selected = 0;
  if (currentTrack()?.url) selectTrack(state.selected);
  renderTrackList();
  updateTrackUI();
  notify(linked ? `Đã nối lại ${linked} file nhạc đã lưu${added.length > linked ? ` và thêm ${added.length - linked} bài mới` : ""}.` : `Đã thêm ${added.length} bài hát vào playlist.`);
}

function field(label, id, value, type = "text", options = {}) {
  if (Object.hasOwn(state.settings, id)) value = state.settings[id];
  if (type === "range") return `<label class="field range-field"><span class="range-head"><span>${label}</span><output for="${id}">${value}${options.unit || ""}</output></span><input id="${id}" type="range" min="${options.min ?? 0}" max="${options.max ?? 100}" step="${options.step ?? 1}" value="${value}"></label>`;
  if (type === "select") return `<label class="field"><span class="field-label">${label}</span><select id="${id}">${options.items.map(item => `<option value="${escapeHtml(item[0])}" ${item[0] === value ? "selected" : ""}>${escapeHtml(item[1])}</option>`).join("")}</select></label>`;
  const inputType = type === "color" ? "color" : type;
  return `<label class="field"><span class="field-label">${label}</span><input id="${id}" type="${inputType}" value="${escapeHtml(value)}" ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""}></label>`;
}

function dropzone(icon, title, hint, inputId, multiple = false) {
  return `<button class="dropzone" type="button" data-file="${inputId}" data-multiple="${multiple}"><span class="drop-icon">${icon}</span><strong>${title}</strong><small>${hint}</small></button>`;
}

function section(title, content, subtitle = "") {
  return `<section class="panel-section"><h2 class="section-heading">${title}</h2>${subtitle ? `<p class="section-subtitle">${subtitle}</p>` : ""}${content}</section>`;
}

function renderPlaylist() {
  return section("Danh sách ca khúc", `
    ${field("Tên playlist", "playlistName", state.settings.playlistName)}
    ${dropzone("♫", "Thêm nhiều bài hát", "Chọn nhiều file MP3, WAV hoặc M4A", "audioFiles")}
    <div class="playlist-meta" id="playlistMeta">0 bài · 00:00</div>
    <div class="track-list" id="trackList"></div>
    <label class="check-row"><input id="autoNext" type="checkbox" ${state.autoNext ? "checked" : ""}> Tự phát bài tiếp theo</label>
    <div class="inline-actions"><button class="small-button" id="loadYoutube">Tải mốc YouTube</button><button class="small-button" id="saveCover">Lưu ảnh bìa</button></div>
  `) + section("Bài đang chọn", `
    <p class="section-subtitle">Thông tin ca khúc, âm lượng và lyric thuộc bài đang chọn. Bố cục bên dưới dùng chung cho cả playlist.</p>
    ${field("Ca sĩ / giọng hát", "artistInput", currentTrack()?.artist || state.settings.artist)}
    ${field("Dòng thông tin ca khúc", "albumInput", currentTrack()?.album || state.settings.album)}
    ${field("Âm lượng bài", "trackVolume", 100, "range", { min: 0, max: 150, unit: "%" })}
    <button class="small-button" id="replaceTrack">↻ &nbsp;Thay file nhạc bài đang chọn</button>
  `) + section("Thiết lập chung · toàn playlist", `
    <p class="section-subtitle">Đĩa, ô vuông, ảnh nền và sóng nhạc giữ nguyên thiết lập khi chuyển bài.</p>
    ${dropzone("◉", "Chọn ảnh trên đĩa nhạc", "Ảnh trên đĩa chung cho toàn playlist", "discImageInput")}
    <div class="inline-actions"><button class="small-button danger" data-clear-image="disc">Bỏ ảnh đĩa</button></div>
    ${dropzone("▣", "Ảnh bìa trong ô vuông", "Ảnh ô vuông chung; độc lập với ảnh trên đĩa", "squareImageInput")}
    <div class="inline-actions"><button class="small-button danger" data-clear-image="square">Bỏ ảnh bìa</button></div>
    ${dropzone("▧", "Ảnh nền toàn video", "JPG, PNG, WebP · ưu tiên ảnh ngang", "backgroundImageInput")}
    <div class="inline-actions"><button class="small-button danger" data-clear-image="background">Bỏ ảnh nền</button></div>
    ${field("Nhận diện kênh", "channelInput", state.channel)}
    <label class="check-row"><input id="showChannel" type="checkbox" ${state.showChannel ? "checked" : ""}> Hiện tên kênh</label>
    <div class="field"><span class="field-label">Logo riêng</span>${dropzone("＋", "Tải logo kênh", "PNG hoặc SVG", "logoInput")}</div>
    <p class="helper-text">Ảnh được lấp đầy khung hình. Dùng phần Ảnh & sóng để chỉnh vị trí và vùng tối cho chữ.</p>
  `);
}

function renderBackground() {
  return section("Edit nền chung · toàn playlist", `
    <p class="section-subtitle">Timeline nền chạy liên tục theo thời gian toàn playlist, không bắt đầu lại khi đổi bài.</p>
    ${dropzone("▶", "Tải video nền toàn khung", "Chọn một hoặc nhiều video MP4, WebM", "backgroundVideoInput", true)}
    ${dropzone("▧", "Tải ảnh nền toàn khung", "Chọn một hoặc nhiều ảnh JPG, PNG, WebP", "backgroundSceneImagesInput", true)}
    <p class="helper-text">Sau khi tải file, chỉnh cắt đầu, thời lượng, vị trí và phóng to trong từng cảnh phía dưới.</p>
  `) + section("Ghép ảnh / video trái–phải", `
    ${dropzone("▧", "Thêm nhiều ảnh và video", "JPG, PNG, WebP, MP4, WebM · chọn nhiều file", "sceneFilesInput", true)}
    <p class="section-subtitle">Các cảnh cùng một bên phát lần lượt rồi lặp lại xuyên suốt playlist. Video gốc tắt tiếng.</p>
    <label class="check-row"><input id="blendEnabled" type="checkbox"> Dùng nền hòa trộn</label>
    ${field("Vị trí đường chia", "splitPosition", 50, "range", { unit: "%" })}
    ${field("Độ rộng vùng giao thoa", "blendWidth", 20, "range", { unit: "%" })}
    ${field("Kiểu chuyển cảnh", "transitionType", "fade", "select", { items: [["fade","Hòa tan mềm"],["left","Quét từ trái"],["right","Quét từ phải"],["zoom","Zoom hòa tan"],["black","Mờ qua màu đen"],["cut","Cắt thẳng"]] })}
    ${field("Chuyển mềm giữa các cảnh", "transitionDuration", 1, "range", { min: 0, max: 5, step: .1, unit: " giây" })}
    ${field("Độ hiện nền hòa trộn", "blendOpacity", 100, "range", { unit: "%" })}
    <div class="scene-list" id="sceneList"></div>
  `) + section("Hiệu ứng lớp phủ", `
    ${field("Hiệu ứng", "overlayEffect", "none", "select", { items: [["none","Không dùng"],["film","Hạt phim"],["vignette","Tối viền"],["glow","Ánh sáng loang"],["film-vignette","Hạt phim + tối viền"]] })}
    ${dropzone("▧", "Thêm ảnh/video lớp phủ", "Ví dụ: ánh sáng, bụi, bokeh trên nền đen", "overlayInput")}
    ${field("Chế độ hòa trộn lớp phủ", "overlayMode", "screen", "select", { items: [["screen","Screen · lọc nền đen"],["soft","Soft light · ánh sáng dịu"],["overlay","Overlay · tăng tương phản"],["normal","Bình thường"]] })}
    ${field("Cường độ lớp phủ", "overlayStrength", 35, "range", { unit: "%" })}
  `) + section("Thứ tự các cảnh", `<p class="helper-text">Kéo thả các cảnh để thay đổi thứ tự phát. Chọn nhiều ảnh hoặc video để bắt đầu.</p>`, "Ảnh nền và cảnh được dùng xuyên suốt video.");
}

function renderLyrics() {
  return section("Lyric riêng cho từng bài", `
    <p class="section-subtitle">Chọn bài trong Playlist rồi dán lyric riêng cho bài đó.</p>
    <label class="check-row"><input id="showSubtitle" type="checkbox" ${state.showSubtitle ? "checked" : ""}> Hiện phụ đề trong video</label>
    <label class="field"><span class="field-label">Lời bài hát · mỗi câu một dòng</span><textarea id="lyricsText" placeholder="Dán toàn bộ lời bài hát tại đây.&#10;Mỗi câu trên một dòng.&#10;Các nhãn [Verse], [Chorus] sẽ được bỏ qua.">${escapeHtml(state.subtitleLines.join("\n"))}</textarea></label>
    <div class="button-row"><button class="small-button" id="markLyric">● Đánh dấu câu</button><button class="small-button" id="clearLyrics">Xóa phụ đề</button></div>
    <div class="notice-box" style="margin-top:12px">Phát nhạc và nhấn Enter khi mỗi câu bắt đầu. Mốc phụ đề được lưu riêng cho từng bài hát.</div>
  `) + section("Phong cách phụ đề", `
    ${field("Hiệu ứng phụ đề", "subtitleEffect", "fade", "select", { items: [["fade","Hiện / mờ nhẹ"],["none","Không hiệu ứng"],["glow","Chữ phát sáng"],["karaoke","Dòng đang hát nổi màu"],["word","Karaoke · tô màu từng từ"],["slide","Trượt lên theo câu"]] })}
    <div class="button-row"><button class="small-button active-toggle" data-sub-layout="single">Một câu gọn</button><button class="small-button" data-sub-layout="double">Hai câu nối tiếp</button></div>
    ${field("Căn chữ", "subtitleAlign", "center", "select", { items: [["left","Căn trái"],["center","Căn giữa"],["right","Căn phải"]] })}
    ${field("Vị trí ngang", "subtitleX", 50, "range", {})}
    ${field("Độ rộng vùng sub", "subtitleWidth", 86, "range", {})}
    ${field("Cỡ chữ", "subtitleSize", state.settings.subtitleSize, "range", { min: 16, max: 90, unit: " px" })}
    ${field("Vị trí phụ đề", "subtitlePosition", state.settings.subtitlePosition, "range", { unit: "%" })}
    ${field("Màu chữ", "subtitleColor", "#ffffff", "color")}
    <label class="check-row"><input id="subtitleBold" type="checkbox" checked> Chữ đậm</label>
    <button class="small-button" id="importLyrics">Nhập lời TXT / SRT</button>
  `);
}

function renderText() {
  return section("Tiêu đề trên video", `
    <label class="check-row"><input id="showTitle" type="checkbox" ${state.showTitle ? "checked" : ""}> Hiện tiêu đề</label>
    ${field("Nội dung tiêu đề", "titleText", currentTrack()?.title || state.settings.title, "text", { placeholder: "Tên bài hát hoặc tiêu đề của bạn" })}
    ${field("Hiệu ứng chữ", "titleEffect", "static", "select", { items: [["static","Đứng yên"],["fade","Hiện / mờ nhẹ"],["slide","Trượt lên"],["type","Gõ từng chữ"],["glow","Phát sáng"]] })}
    ${field("Font tiêu đề", "titleFont", "serif", "select", { items: [["serif","Serif — điện ảnh"],["sans","Sans — hiện đại"]] })}
    ${field("Cỡ tiêu đề", "titleSize", state.settings.titleSize, "range", { min: 18, max: 120, unit: " px" })}
    ${field("Vị trí tiêu đề", "titlePosition", state.settings.titlePosition, "range", { unit: "%" })}
    ${field("Màu tiêu đề", "titleColor", "#ffffff", "color")}
    <div class="number-inputs">${field("Bắt đầu (giây)", "titleStart", 0, "number")}${field("Kết thúc (giây)", "titleEnd", 0, "number")}</div>
  `) + section("Ghi chú / dòng chữ phụ", `
    <label class="check-row"><input id="showNote" type="checkbox" ${state.showNote ? "checked" : ""}> Hiện ghi chú</label>
    ${field("Nội dung", "noteText", "", "text", { placeholder: "Ví dụ: Cover Rock Ballad · AurioMusic" })}
    ${field("Hiệu ứng ghi chú", "noteEffect", "fade", "select", { items: [["fade","Hiện / mờ nhẹ"],["static","Đứng yên"],["slide","Trượt lên"],["type","Gõ từng chữ"],["glow","Phát sáng"]] })}
    ${field("Cỡ ghi chú", "noteSize", 30, "range", { min: 12, max: 72, unit: " px" })}
    ${field("Vị trí ghi chú", "notePosition", 40, "range", { unit: "%" })}
    ${field("Màu ghi chú", "noteColor", "#edb969", "color")}
    <p class="helper-text">Kết thúc = 0 để hiện đến hết bài. Nhấn Phát để xem hiệu ứng trực tiếp trên khung preview.</p>
  `);
}

function renderVisuals() {
  return section("Bố cục chung · toàn playlist", `
    <p class="section-subtitle">Kích thước, vị trí, màu sắc và hiệu ứng áp dụng cho mọi bài trong video dài.</p>
    ${field("Kiểu bố cục", "layoutType", state.settings.layout, "select", { items: [["vinyl","Đĩa xoay + ô thông tin vuông"],["background","Ảnh nền + chữ"]] })}
    ${field("Phần đĩa bị ô vuông che", "recordOverlap", 22, "range", { unit: "%" })}
    ${field("Tốc độ xoay", "spinSpeed", 6, "range", { min: 0, max: 30, unit: " vòng/phút" })}
    ${field("Kích thước chung bố cục", "layoutScale", 100, "range", { min: 50, max: 150, unit: "%" })}
    ${field("Kích thước riêng đĩa", "recordScale", 100, "range", { min: 50, max: 150, unit: "%" })}
    ${field("Trái ↔ phải", "recordX", 0, "range", { min: -30, max: 30, unit: "%" })}
    ${field("Lên ↔ xuống", "recordY", 0, "range", { min: -30, max: 30, unit: "%" })}
    ${field("Độ tối ảnh bìa / ô thông tin", "coverDarkness", 85, "range", { unit: "%" })}
  `) + section("Ảnh nền", `
    ${field("Tỷ lệ khung hình", "aspectRatio", "16:9", "select", { items: [["16:9","16:9 — YouTube"],["9:16","9:16 — Shorts"]] })}
    ${field("Chuyển động ảnh", "imageMotion", "zoom", "select", { items: [["zoom","Zoom chậm"],["pan","Dịch ngang nhẹ"],["static","Ảnh tĩnh"]] })}
    ${field("Vị trí ảnh ngang", "imageX", 50, "range", {})}
    ${field("Vị trí ảnh dọc", "imageY", 50, "range", {})}
    ${field("Làm tối nền", "backgroundDarkness", state.settings.darkness, "range", { unit: "%" })}
    <label class="check-row"><input id="ambientParticles" type="checkbox" checked> Bụi sáng chuyển động nhẹ</label>
  `) + section("Sóng nhạc", `
    ${field("Kiểu sóng", "waveType", "bars", "select", { items: [["bars","01 · Thanh phổ âm"],["mirror","02 · Thanh đối xứng"],["line","03 · Đường sóng âm"],["soft","04 · Dải sóng mềm"],["particles","05 · Hạt sáng"],["ring","06 · Vòng phổ âm"],["off","Tắt sóng nhạc"]] })}
    ${field("Màu sóng", "waveColor", state.settings.waveColor, "color")}
    ${field("Chiều cao / biên độ", "waveAmplitude", 70, "range", {})}
    ${field("Độ nhạy", "waveSensitivity", 100, "range", { unit: "%" })}
    ${field("Vị trí sóng", "wavePosition", 92, "range", { unit: "%" })}
    <label class="check-row"><input id="waveGlow" type="checkbox" ${state.settings.waveGlow !== false ? "checked" : ""}> Sóng phát sáng</label>
    <button class="small-button" id="resetVisuals">Khôi phục phong cách mặc định</button>
  `);
}

function renderPanel(tab = state.activeTab) {
  state.activeTab = tab;
  $$(".tab").forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  panels.innerHTML = ({ playlist: renderPlaylist, background: renderBackground, lyrics: renderLyrics, text: renderText, visuals: renderVisuals })[tab]();
  renderTrackList();
  renderSceneList();
  bindPanelEvents();
  syncPreviewLayout();
  syncRecordRotation();
  applyWaveSettings();
}

function syncRecordRotation() {
  const record = $("#record");
  if (!record) return;
  const speed = Math.max(0, Number(state.settings.spinSpeed ?? 6));
  record.style.setProperty("--record-spin-duration", speed > 0 ? `${60 / speed}s` : "0s");
  record.style.animationPlayState = speed > 0 && !audio.paused ? "running" : "paused";
}

function setRangeOutputs() {
  $$('input[type="range"]', panels).forEach(input => input.addEventListener("input", () => {
    const output = $(`output[for="${input.id}"]`, panels);
    if (output) output.textContent = `${input.value}${output.textContent.replace(/^[\d.-]+/, "")}`;
    if (input.id === "subtitleSize") state.settings.subtitleSize = Number(input.value);
    if (input.id === "subtitlePosition") state.settings.subtitlePosition = Number(input.value);
    if (input.id === "titleSize") state.settings.titleSize = Number(input.value);
    if (input.id === "titlePosition") state.settings.titlePosition = Number(input.value);
    if (input.id === "backgroundDarkness") state.settings.darkness = Number(input.value);
    if (input.id === "trackVolume") audio.volume = Math.min(Number(input.value) / 100, 1);
    if (input.id === "subtitleSize") $("#subtitlePreview").style.fontSize = `${Number(input.value) / 2.5}px`;
    if (input.id === "subtitlePosition") $("#subtitlePreview").style.bottom = `${100 - Number(input.value)}%`;
    if (input.id === "titleSize") $("#previewTitle").style.fontSize = `${Number(input.value) / 2.2}px`;
    if (input.id === "titleSize") $("#floatingTitle").style.fontSize = `${Number(input.value) / 1.8}px`;
    if (input.id === "titlePosition") $("#floatingTitle").style.top = `${Number(input.value)}%`;
    if (input.id === "layoutScale") $("#musicScene").style.scale = String(Number(input.value) / 100);
    if (input.id === "spinSpeed") syncRecordRotation();
    if (input.id === "backgroundDarkness") $("#previewBackdrop").style.filter = `brightness(${1 - Number(input.value) / 140})`;
    if (input.id.startsWith("wave")) applyWaveSettings();
  }));
}

function bindPanelEvents() {
  $$("[data-file]", panels).forEach(button => button.addEventListener("click", () => {
    const input = $(`#${button.dataset.file}`);
    if (input) input.click();
  }));
  $$(".field input:not([type=checkbox]), .field select, .field textarea", panels).forEach(control => {
    const saveSetting = () => { state.settings[control.id] = control.type === "range" || control.type === "number" ? Number(control.value) : control.value; };
    control.addEventListener("input", saveSetting);
    control.addEventListener("change", saveSetting);
  });
  const onInput = (id, callback) => { const input = $(`#${id}`, panels); if (input) input.addEventListener("input", () => callback(input)); };
  const onChange = (id, callback) => { const input = $(`#${id}`, panels); if (input) input.addEventListener("change", () => callback(input)); };

  onInput("playlistName", el => { state.settings.playlistName = el.value; });
  onInput("artistInput", el => { state.settings.artist = el.value; const track = currentTrack(); if (track) track.artist = el.value; updateTrackUI(); renderTrackList(); });
  onInput("albumInput", el => { state.settings.album = el.value; const track = currentTrack(); if (track) track.album = el.value; updateTrackUI(); });
  onInput("channelInput", el => { state.channel = el.value; updateTrackUI(); });
  onChange("autoNext", el => { state.autoNext = el.checked; });
  onChange("showChannel", el => { state.showChannel = el.checked; updateTrackUI(); });
  onChange("showSubtitle", el => { state.showSubtitle = el.checked; updateTrackUI(); });
  onInput("lyricsText", el => {
    state.subtitleLines = el.value.split(/\r?\n/).filter(line => line.trim() && !/^\s*\[(verse|chorus|bridge|intro|outro)/i.test(line));
    const track = currentTrack();
    if (track) { track.lyrics = state.subtitleLines; track.lyricMarks = state.subtitleMarks; }
    updateTrackUI();
  });
  onChange("layoutType", el => {
    state.settings.layout = el.value;
    syncPreviewLayout();
  });
  onInput("titleText", el => { state.settings.title = el.value; $("#previewTitle").textContent = el.value; $("#floatingTitle").textContent = el.value; });
  onInput("noteText", el => { state.settings.noteText = el.value; $("#previewNote").textContent = el.value; });
  onChange("showTitle", el => {
    state.showTitle = el.checked;
    $("#previewTitle").hidden = !el.checked;
    syncPreviewLayout();
  });
  onChange("showNote", el => {
    state.showNote = el.checked;
    syncPreviewLayout();
  });
  onInput("waveColor", el => {
    state.settings.waveColor = el.value;
    applyWaveSettings();
  });
  onChange("waveType", el => { state.settings.waveType = el.value; applyWaveSettings(); });
  onChange("waveGlow", el => { state.settings.waveGlow = el.checked; applyWaveSettings(); });
  onChange("backgroundDarkness", el => { state.settings.darkness = Number(el.value); });
  onChange("titleColor", el => { state.settings.titleColor = el.value; $("#previewTitle").style.color = el.value; });
  onChange("subtitleColor", el => { state.settings.subtitleColor = el.value; $("#subtitlePreview").style.color = el.value; });

  $("#replaceTrack", panels)?.addEventListener("click", () => {
    if (state.selected < 0) return notify("Hãy chọn bài hát cần thay trước.");
    $("#replaceAudio").click();
  });
  $("#loadYoutube", panels)?.addEventListener("click", () => notify("Nhập mốc YouTube sẽ được hỗ trợ khi kết nối nguồn video."));
  $("#saveCover", panels)?.addEventListener("click", () => saveCoverImage());
  $("#markLyric", panels)?.addEventListener("click", markLyric);
  $("#clearLyrics", panels)?.addEventListener("click", () => {
    state.subtitleLines = [];
    state.subtitleMarks = [];
    const track = currentTrack();
    if (track) { track.lyrics = []; track.lyricMarks = []; }
    renderPanel("lyrics");
    updateTrackUI();
    notify("Đã xóa lời bài hát.");
  });
  $("#importLyrics", panels)?.addEventListener("click", () => $("#lyricFileInput").click());
  $("#resetVisuals", panels)?.addEventListener("click", () => { state.settings.layout = "vinyl"; renderPanel("visuals"); notify("Đã khôi phục thiết lập mặc định."); });
  $$("[data-clear-image]", panels).forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.clearImage;
    state.images[key] = null;
    delete $("#previewFrame").dataset[`${key}Image`];
    if (imageUrls[key]) { URL.revokeObjectURL(imageUrls[key]); delete imageUrls[key]; }
    if (key === "background") $("#previewFrame").style.backgroundImage = "";
    if (key === "square") $("#coverPhoto").style.backgroundImage = "";
    if (key === "disc") $(".record-label").style.backgroundImage = "";
    notify("Đã bỏ ảnh.");
  }));
  $$("[data-sub-layout]", panels).forEach(button => button.addEventListener("click", () => {
    $$("[data-sub-layout]", panels).forEach(item => item.classList.toggle("active-toggle", item === button));
    $("#subtitlePreview").style.whiteSpace = button.dataset.subLayout === "single" ? "nowrap" : "normal";
  }));
  setRangeOutputs();
}

function markLyric() {
  if (!state.subtitleLines.length) return notify("Hãy dán lời bài hát trước khi đánh dấu.");
  const line = state.subtitleLines[state.subtitleMarks.length % state.subtitleLines.length];
  state.subtitleMarks.push({ text: line, time: audio.currentTime || 0 });
  const track = currentTrack();
  if (track) track.lyricMarks = state.subtitleMarks;
  $("#subtitlePreview").textContent = line;
  $("#subtitlePreview").hidden = !state.showSubtitle;
  notify(`Đã đánh dấu câu tại ${formatTime(audio.currentTime)}.`);
}

function saveCoverImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
  gradient.addColorStop(0, "#1b2029"); gradient.addColorStop(.58, "#100f11"); gradient.addColorStop(1, "#302416");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = "#e5b65f"; ctx.font = "22px sans-serif"; ctx.fillText(state.channel, 70, 70);
  ctx.fillStyle = "#f2f0ea"; ctx.textAlign = "center"; ctx.font = "600 64px Georgia";
  ctx.fillText(currentTrack()?.title || state.settings.playlistName, 640, 350, 1000);
  ctx.fillStyle = "#d7ba7e"; ctx.font = "24px sans-serif"; ctx.fillText(currentTrack()?.artist || state.settings.artist, 640, 405);
  canvas.toBlob(blob => {
    if (!blob) return notify("Không thể tạo ảnh bìa.");
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "auriovideo-cover.png"; link.click(); URL.revokeObjectURL(link.href);
  });
}

function attachImageInput(id, key, apply) {
  $(`#${id}`).addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (imageUrls[key]) URL.revokeObjectURL(imageUrls[key]);
    const url = URL.createObjectURL(file); imageUrls[key] = url; state.images[key] = file;
    apply(url);
    notify(`Đã cập nhật ${file.name}.`);
    event.target.value = "";
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Không thể lưu ảnh ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function saveProject() {
  let images;
  try {
    images = Object.fromEntries(await Promise.all(Object.entries(state.images).map(async ([key, file]) => [
      key,
      file instanceof File ? await fileToDataUrl(file) : file
    ])));
  } catch (error) {
    notify(error.message || "Không thể lưu ảnh của dự án.");
    return;
  }
  const project = {
    version: 1,
    playlistName: state.settings.playlistName,
    channel: state.channel,
    showChannel: state.showChannel,
    showTitle: state.showTitle,
    showNote: state.showNote,
    autoNext: state.autoNext,
    showSubtitle: state.showSubtitle,
    tracks: state.tracks.map(track => ({
      title: track.title,
      fileName: track.fileName || track.file?.name || "",
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      lyrics: track.lyrics || [],
      lyricMarks: track.lyricMarks || []
    })),
    lyrics: state.subtitleLines,
    lyricMarks: state.subtitleMarks,
    settings: state.settings,
    images
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${(state.settings.playlistName || "auriovideo").replace(/[\\/:*?"<>|]/g, "-")}.json`; link.click(); URL.revokeObjectURL(url);
  notify("Đã lưu cấu hình dự án. Khi mở lại, hãy chọn lại file nhạc.");
}

async function openProject(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.tracks)) throw new Error("Tệp dự án không đúng định dạng.");
    state.settings = { ...state.settings, ...(data.settings || {}), playlistName: data.playlistName || data.settings?.playlistName || state.settings.playlistName };
    state.channel = data.channel || "AurioMusic";
    state.showChannel = data.showChannel !== false;
    state.showTitle = data.showTitle !== false;
    state.showNote = data.showNote !== false;
    state.autoNext = data.autoNext !== false;
    state.showSubtitle = data.showSubtitle !== false;
    state.subtitleLines = Array.isArray(data.lyrics) ? data.lyrics : [];
    state.subtitleMarks = Array.isArray(data.lyricMarks) ? data.lyricMarks : [];
    state.tracks = data.tracks.map(track => ({ ...track, url: "", file: null }));
    state.images = data.images || {};
    Object.entries(state.images).forEach(([key, url]) => {
      if (typeof url !== "string" || !url.startsWith("data:image/")) return;
      if (key === "disc") {
        $(".record-label").style.backgroundImage = `url("${url}")`;
        $(".record-label").style.backgroundSize = "cover";
        $(".record-label").style.backgroundPosition = "center";
      }
      if (key === "square") $("#coverPhoto").style.backgroundImage = `url("${url}")`;
      if (key === "background") {
        $("#previewFrame").style.backgroundImage = `linear-gradient(#080a0d99,#080a0dcc),url("${url}")`;
        $("#previewFrame").style.backgroundSize = "cover";
        $("#previewFrame").style.backgroundPosition = "center";
      }
    });
    state.selected = state.tracks.length ? 0 : -1;
    if (state.selected >= 0) {
      const selectedTrack = state.tracks[state.selected];
      if (Array.isArray(selectedTrack.lyrics)) state.subtitleLines = selectedTrack.lyrics;
      if (Array.isArray(selectedTrack.lyricMarks)) state.subtitleMarks = selectedTrack.lyricMarks;
    }
    audio.pause(); audio.removeAttribute("src"); audio.load();
    renderPanel(state.activeTab); updateTrackUI();
    if (state.tracks.length) notify("Đã mở dự án. Thêm lại file nhạc để phát và xuất video.");
    else notify("Đã mở dự án thành công.");
  } catch (error) {
    notify(error.message || "Không thể mở tệp dự án.");
  }
}

function loadCanvasArtwork() {
  return Promise.all(Object.entries(state.images).map(([key, source]) => new Promise((resolve, reject) => {
    if (!source) return resolve([key, null]);
    const image = new Image();
    const objectUrl = source instanceof Blob ? URL.createObjectURL(source) : null;
    image.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve([key, image]);
    };
    image.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error(`Không thể nạp ảnh ${key} để xuất video.`));
    };
    image.src = objectUrl || source;
  }))).then(entries => Object.fromEntries(entries));
}

function drawImageCover(context, image, x, y, width, height) {
  if (!image?.naturalWidth || !image?.naturalHeight) return;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  context.drawImage(
    image,
    (image.naturalWidth - sourceWidth) / 2,
    (image.naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height
  );
}

function drawCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  lines.forEach((item, index) => context.fillText(item, x, y + index * lineHeight, maxWidth));
  return lines.length;
}

function drawVinylArtwork(context, artwork, time) {
  const centerX = 476 + Number(state.settings.recordX || 0) * 4;
  const centerY = 360 + Number(state.settings.recordY || 0) * 4;
  const radius = 218 * Math.max(.5, Math.min(1.5, Number(state.settings.recordScale || 100) / 100));
  const overlap = Number(state.settings.recordOverlap ?? 22);
  const cardX = centerX + radius * (1 - overlap / 100) - 22;
  const cardY = 140;
  const cardSize = 440;
  const track = currentTrack();
  const spin = time * Number(state.settings.spinSpeed ?? 6) * Math.PI / 30;

  context.save();
  context.shadowColor = "#000b";
  context.shadowBlur = 55;
  context.shadowOffsetY = 24;
  const disc = context.createRadialGradient(centerX - 70, centerY - 92, 12, centerX, centerY, radius);
  disc.addColorStop(0, "#46423d");
  disc.addColorStop(.42, "#17191b");
  disc.addColorStop(.82, "#090a0c");
  disc.addColorStop(1, "#262626");
  context.fillStyle = disc;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  context.translate(centerX, centerY);
  context.rotate(spin);
  for (let ring = 0; ring < 13; ring++) {
    context.beginPath();
    context.arc(0, 0, radius * (.46 + ring * .038), 0, Math.PI * 2);
    context.strokeStyle = ring % 3 === 0 ? "#e2d2af20" : "#ffffff0d";
    context.lineWidth = ring % 3 === 0 ? 1.5 : 1;
    context.stroke();
  }
  const reflection = context.createLinearGradient(-radius, -radius, radius, radius);
  reflection.addColorStop(0, "#ffffff26");
  reflection.addColorStop(.24, "#ffffff00");
  reflection.addColorStop(.58, "#d9c29b0d");
  reflection.addColorStop(1, "#ffffff00");
  context.fillStyle = reflection;
  context.beginPath();
  context.arc(0, 0, radius * .97, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(0, 0, radius * .9, -.045, .045);
  context.strokeStyle = "#e2c07d80";
  context.lineWidth = 2;
  context.stroke();
  context.beginPath();
  context.arc(radius * .87, 0, 2.5, 0, Math.PI * 2);
  context.fillStyle = "#f2d9a6a8";
  context.fill();
  context.restore();

  context.save();
  context.shadowColor = "#0009";
  context.shadowBlur = 24;
  context.fillStyle = "#0c0d0e";
  context.beginPath();
  context.arc(centerX, centerY, 96, 0, Math.PI * 2);
  context.fill();
  context.restore();
  context.save();
  context.beginPath();
  context.arc(centerX, centerY, 86, 0, Math.PI * 2);
  context.clip();
  if (artwork.disc) drawImageCover(context, artwork.disc, centerX - 86, centerY - 86, 172, 172);
  else {
    const label = context.createRadialGradient(centerX - 22, centerY - 26, 1, centerX, centerY, 88);
    label.addColorStop(0, "#f7daa0");
    label.addColorStop(1, "#c58f3f");
    context.fillStyle = label;
    context.fillRect(centerX - 88, centerY - 88, 176, 176);
    context.fillStyle = "#322419";
    context.textAlign = "center";
    context.font = "600 17px Georgia";
    context.fillText(state.channel || "AurioMusic", centerX, centerY - 2, 145);
    context.font = "700 7px sans-serif";
    context.fillText("RECORD LABEL", centerX, centerY + 17);
  }
  context.restore();
  context.beginPath();
  context.arc(centerX, centerY, 5, 0, Math.PI * 2);
  context.fillStyle = "#101113";
  context.fill();

  context.save();
  context.shadowColor = "#000b";
  context.shadowBlur = 42;
  context.shadowOffsetY = 18;
  context.beginPath();
  context.roundRect(cardX, cardY, cardSize, cardSize, 8);
  context.fillStyle = "#101318";
  context.fill();
  context.restore();
  context.save();
  context.beginPath();
  context.roundRect(cardX, cardY, cardSize, cardSize, 8);
  context.clip();
  if (artwork.square) drawImageCover(context, artwork.square, cardX, cardY, cardSize, cardSize);
  else {
    const cover = context.createLinearGradient(cardX, cardY, cardX + cardSize, cardY + cardSize);
    cover.addColorStop(0, "#29251f");
    cover.addColorStop(.48, "#15171b");
    cover.addColorStop(1, "#33291e");
    context.fillStyle = cover;
    context.fillRect(cardX, cardY, cardSize, cardSize);
    context.strokeStyle = "#cda86623";
    for (let index = 0; index < 7; index++) {
      context.beginPath();
      context.arc(cardX + 390, cardY + 76, 34 + index * 30, 0, Math.PI * 2);
      context.stroke();
    }
  }
  const shade = context.createLinearGradient(cardX, cardY, cardX, cardY + cardSize);
  const coverDarkness = Math.max(0, Math.min(100, Number(state.settings.coverDarkness ?? 85))) / 100;
  shade.addColorStop(0, `rgba(9,11,16,${.38 + coverDarkness * .35})`);
  shade.addColorStop(.2, `rgba(9,11,16,${.12 + coverDarkness * .2})`);
  shade.addColorStop(.55, `rgba(9,11,16,${.12 + coverDarkness * .2})`);
  shade.addColorStop(1, `rgba(9,11,16,${.48 + coverDarkness * .45})`);
  context.fillStyle = shade;
  context.fillRect(cardX, cardY, cardSize, cardSize);
  context.strokeStyle = "#ffffff28";
  context.lineWidth = 1;
  context.strokeRect(cardX + .5, cardY + .5, cardSize - 1, cardSize - 1);
  context.textAlign = "left";
  context.fillStyle = "#e8cc95";
  context.font = "600 10px Arial";
  context.letterSpacing = "1.4px";
  context.fillText("AURIO MUSIC", cardX + 34, cardY + 40);
  context.textAlign = "right";
  context.fillStyle = "#ffffffb8";
  context.font = "600 9px Arial";
  context.fillText("SIDE A · 01", cardX + cardSize - 34, cardY + 40);
  context.strokeStyle = "#ffffff42";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(cardX + 34, cardY + 57);
  context.lineTo(cardX + cardSize - 34, cardY + 57);
  context.stroke();
  context.letterSpacing = "0px";
  context.textAlign = "center";
  if (state.showTitle) {
    const title = track?.title || state.settings.title || "Tên bài hát";
    const titleSize = Math.min(42, Math.max(25, Number(state.settings.titleSize || 64) * .58));
    context.fillStyle = state.settings.titleColor || "#f5f1e9";
    context.shadowColor = "#000b";
    context.shadowBlur = 12;
    context.font = `600 ${titleSize}px ${state.settings.titleFont === "sans" ? "Arial" : "Georgia"}`;
    const lineCount = drawCanvasText(context, title, cardX + cardSize / 2, cardY + 203, cardSize - 60, titleSize * 1.13, 2);
    context.shadowBlur = 0;
    const titleBottom = cardY + 203 + Math.max(0, lineCount - 1) * titleSize * 1.13;
    context.fillStyle = "#e7c887";
    context.beginPath();
    context.moveTo(cardX + cardSize / 2 - 12, titleBottom + 17);
    context.lineTo(cardX + cardSize / 2 + 12, titleBottom + 17);
    context.strokeStyle = "#e7c887c0";
    context.lineWidth = 1.2;
    context.stroke();
    context.fillStyle = "#fff4e6";
    context.font = "500 17px Arial";
    context.fillText(track?.artist || state.settings.artist || "", cardX + cardSize / 2, titleBottom + 47, cardSize - 62);
  }
  context.fillStyle = "#e8cc95";
  context.font = "600 9px Arial";
  context.letterSpacing = "1.3px";
  context.fillText((track?.album || state.settings.album || "MUSIC").toUpperCase(), cardX + cardSize / 2, cardY + cardSize - 37, cardSize - 68);
  context.letterSpacing = "0px";
  context.restore();
}

function drawBackgroundArtwork(context, artwork) {
  if (artwork.background) drawImageCover(context, artwork.background, 0, 0, 1280, 720);
  else {
    const background = context.createLinearGradient(0, 0, 1280, 720);
    background.addColorStop(0, "#202a32");
    background.addColorStop(.48, "#12171c");
    background.addColorStop(1, "#2d241a");
    context.fillStyle = background;
    context.fillRect(0, 0, 1280, 720);
  }
  const darkness = Math.max(0, Math.min(100, Number(state.settings.darkness ?? 30))) / 100;
  const shade = context.createLinearGradient(0, 0, 0, 720);
  shade.addColorStop(0, `rgba(5,7,10,${.42 + darkness * .25})`);
  shade.addColorStop(.52, `rgba(5,7,10,${.35 + darkness * .28})`);
  shade.addColorStop(1, `rgba(5,7,10,${.7 + darkness * .27})`);
  context.fillStyle = shade;
  context.fillRect(0, 0, 1280, 720);
  const titleY = Math.min(620, Math.max(100, Number(state.settings.titlePosition ?? 42) * 7.2));
  const track = currentTrack();
  context.textAlign = "center";
  if (state.showTitle) {
    context.fillStyle = state.settings.titleColor || "#ffffff";
    context.shadowColor = "#000c";
    context.shadowBlur = 24;
    const size = Math.min(88, Math.max(36, Number(state.settings.titleSize || 64)));
    context.font = `600 ${size}px ${state.settings.titleFont === "sans" ? "Arial" : "Georgia"}`;
    drawCanvasText(context, track?.title || state.settings.title || "Tên bài hát", 640, titleY, 1040, size * 1.12, 2);
    context.shadowBlur = 0;
  }
  context.fillStyle = "#e4c27d";
  context.font = "500 25px Arial";
  context.fillText(track?.artist || state.settings.artist || "", 640, titleY + 52, 980);
  if (state.showNote && state.settings.noteText) {
    const noteY = Math.min(650, Math.max(80, Number(state.settings.notePosition ?? 57) * 7.2));
    context.fillStyle = state.settings.noteColor || "#edb969";
    context.font = `500 ${Math.min(58, Math.max(20, Number(state.settings.noteSize || 30)))}px Arial`;
    context.fillText(state.settings.noteText, 640, noteY, 1000);
  }
}

function drawExportSubtitle(context) {
  if (!state.showSubtitle || !state.subtitleLines.length) return;
  const activeMark = [...state.subtitleMarks].reverse().find(mark => mark.time <= audio.currentTime);
  const text = activeMark?.text || state.subtitleLines[Math.min(
    state.subtitleLines.length - 1,
    Math.floor(audio.currentTime / (audio.duration / state.subtitleLines.length || 1))
  )];
  if (!text) return;
  const y = Math.min(680, Math.max(100, Number(state.settings.subtitlePosition ?? 76) * 7.2));
  const fontSize = Math.min(52, Math.max(22, Number(state.settings.subtitleSize ?? 44) * .65));
  context.save();
  context.font = `700 ${fontSize}px Arial`;
  const width = Math.min(1120, Math.max(520, context.measureText(text).width + 72));
  context.fillStyle = "#080a0dc9";
  context.beginPath();
  context.roundRect(640 - width / 2, y - fontSize - 17, width, fontSize + 38, 12);
  context.fill();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = state.settings.subtitleColor || "#ffffff";
  context.shadowColor = "#000";
  context.shadowBlur = 7;
  context.fillText(text, 640, y, width - 52);
  context.restore();
}

async function exportVideo() {
  if (!currentTrack()?.url) return notify("Thêm và chọn một file nhạc trước khi xuất video.");
  if (state.tracks.some(track => !track.url)) return notify("Hãy thêm lại tất cả file nhạc của dự án trước khi xuất.");
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return notify("Trình duyệt này chưa hỗ trợ xuất WebM. Hãy thử Chrome hoặc Edge mới.");
  const exportButton = $("#exportVideo");
  exportButton.disabled = true;
  let stream;
  let recorder;
  let chunks = [];
  let finished = false;
  let failed = false;
  let artwork = {};
  let exportIndex = state.selected;
  let playStartTimeout = 0;
  let frameTimer = 0;
  const originalOnEnded = audio.onended;
  const updateExportProgress = () => {
    if (!exportInProgress || audio.duration <= 0) return;
    exportButton.textContent = `Đang xuất ${exportIndex + 1}/${state.tracks.length} · ${formatTime(audio.currentTime)}/${formatTime(audio.duration)}…`;
  };
  const handleExportAudioError = () => {
    failed = true;
    cleanup();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    notify("File nhạc bị lỗi khi đang xuất. Hãy chọn lại file rồi thử lại.");
  };
  const resetExportButton = () => {
    exportButton.disabled = false;
    exportButton.innerHTML = 'Xuất video <span>↗</span>';
  };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    audio.pause();
    audio.onended = originalOnEnded;
    audio.removeEventListener("timeupdate", updateExportProgress);
    audio.removeEventListener("error", handleExportAudioError);
    clearTimeout(playStartTimeout);
    clearInterval(frameTimer);
    exportInProgress = false;
    stream?.getTracks().forEach(track => track.stop());
    resetExportButton();
  };
  let audioContext;
  try {
    exportButton.textContent = "Đang chuẩn bị khung hình…";
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Không thể tạo khung hình video trên trình duyệt này.");
    stream = canvas.captureStream(30);
    if (!stream) throw new Error("Không thể khởi tạo luồng video để xuất.");
    exportButton.textContent = "Đang nạp ảnh bìa…";
    artwork = await loadCanvasArtwork();
    exportButton.textContent = "Đang khởi tạo âm thanh…";
    audioContext = ensureAudioAnalyser();
    await audioContext.resume();
    const captureAudio = audio.captureStream || audio.mozCaptureStream;
    if (!captureAudio) throw new Error("Trình duyệt chưa hỗ trợ thu âm thanh khi xuất. Hãy dùng Chrome hoặc Edge mới.");
    const audioTracks = captureAudio.call(audio).getAudioTracks();
    if (!audioTracks.length) throw new Error("Không lấy được luồng âm thanh để xuất video.");
    audioTracks.forEach(track => stream.addTrack(track));
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("Trình duyệt không hỗ trợ định dạng WebM.");
    exportButton.textContent = "Đang nạp âm thanh…";
    if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Không nạp được âm thanh. Kiểm tra file nhạc rồi thử xuất lại."));
        }, 15000);
        const clear = () => {
          clearTimeout(timeout);
          audio.removeEventListener("canplay", ready);
          audio.removeEventListener("error", failedToLoad);
        };
        const ready = () => { clear(); resolve(); };
        const failedToLoad = () => {
          clear();
          reject(new Error("Không đọc được file nhạc. Hãy kiểm tra định dạng hoặc chọn lại file."));
        };
        audio.addEventListener("canplay", ready, { once: true });
        audio.addEventListener("error", failedToLoad, { once: true });
        if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready();
      });
    }
    recorder = new MediaRecorder(stream, { mimeType });
    const drawFrame = () => {
      if (state.settings.layout === "background") {
        drawBackgroundArtwork(ctx, artwork);
      } else {
        if (artwork.background) {
          drawImageCover(ctx, artwork.background, 0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#080a0dcc";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          const gradient = ctx.createRadialGradient(640, 350, 30, 640, 360, 760);
          gradient.addColorStop(0, "#24211d");
          gradient.addColorStop(.56, "#11141a");
          gradient.addColorStop(1, "#07080b");
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        const scale = Math.max(.5, Math.min(1.5, Number(state.settings.layoutScale || 100) / 100));
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(scale, scale);
        ctx.translate(-canvas.width / 2, -canvas.height / 2);
        drawVinylArtwork(ctx, artwork, audio.currentTime);
        ctx.restore();
      }
      const vignette = ctx.createRadialGradient(640, 360, 300, 640, 360, 790);
      vignette.addColorStop(0, "#00000000");
      vignette.addColorStop(1, "#00000082");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (state.showChannel) {
        if (artwork.logo) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(66, 48, 38, 38, 10);
          ctx.clip();
          drawImageCover(ctx, artwork.logo, 66, 48, 38, 38);
          ctx.restore();
        }
        ctx.fillStyle = "#e4c27d";
        ctx.textAlign = "left";
        ctx.font = "600 16px Georgia";
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 8;
        ctx.fillText(state.channel || "AurioMusic", artwork.logo ? 116 : 68, 73, 320);
        ctx.shadowBlur = 0;
      }
      if (state.showNote && state.settings.layout === "vinyl" && state.settings.noteText) {
        ctx.fillStyle = state.settings.noteColor || "#edb969";
        ctx.textAlign = "center";
        ctx.font = `500 ${Math.min(36, Math.max(18, Number(state.settings.noteSize || 30) * .7))}px Arial`;
        ctx.fillText(state.settings.noteText, 640, 600, 900);
      }
      drawExportSubtitle(ctx);
      drawWave(ctx, canvas.width, canvas.height);
    };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      if (failed) return cleanup();
      try {
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) throw new Error("Video xuất ra bị rỗng. Hãy thử lại hoặc dùng Chrome/Edge.");
        const url = URL.createObjectURL(blob); const link = document.createElement("a");
        link.href = url; link.download = `${(currentTrack()?.title || "auriovideo").replace(/[\\/:*?"<>|]/g, "-")}.webm`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        cleanup();
        notify("Video playlist WebM đã xuất xong.");
      } catch (error) {
        cleanup();
        notify(error.message || "Không thể lưu video đã xuất.");
      }
    };
    recorder.onerror = event => {
      failed = true;
      cleanup();
      notify(event.error?.message || "Lỗi khi ghi video. Hãy thử lại bằng Chrome hoặc Edge.");
    };
    exportInProgress = true;
    audio.currentTime = 0;
    audio.onended = () => {
      if (exportIndex + 1 < state.tracks.length) {
        exportIndex += 1;
        exportButton.textContent = `Đang xuất ${exportIndex + 1}/${state.tracks.length}…`;
        selectTrack(exportIndex);
        audio.currentTime = 0;
        audio.play().catch(error => {
          failed = true;
          cleanup();
          if (recorder.state !== "inactive") recorder.stop();
          notify(error.message || "Không thể phát track tiếp theo khi xuất video.");
        });
      } else if (recorder.state !== "inactive") {
        recorder.requestData();
        setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, 0);
      }
    };
    recorder.start(1000);
    drawFrame();
    frameTimer = setInterval(drawFrame, 1000 / 30);
    exportButton.textContent = `Đang xuất 1/${state.tracks.length}…`;
    audio.addEventListener("timeupdate", updateExportProgress);
    audio.addEventListener("error", handleExportAudioError);
    notify(`Đang xuất ${state.tracks.length} bài · giữ trang này mở đến khi hoàn tất.`);
    const playbackStarted = audio.play();
    await Promise.race([
      playbackStarted,
      new Promise((_, reject) => {
        playStartTimeout = setTimeout(() => reject(new Error("Không bắt đầu phát được nhạc sau 15 giây. Kiểm tra file hoặc thử lại bằng Chrome/Edge.")), 15000);
      })
    ]);
    clearTimeout(playStartTimeout);
  } catch (error) {
    failed = true;
    cleanup();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    notify(error.message || "Không thể xuất video.");
  }
}

function init() {
  renderPanel("playlist");
  updateTrackUI();
  applyWaveSettings();
  window.addEventListener("resize", applyWaveSettings);
  $$(".tab").forEach(button => button.addEventListener("click", () => renderPanel(button.dataset.tab)));
  $("#backgroundShortcut").addEventListener("click", () => { renderPanel("background"); panels.scrollTop = 0; });
  $("#audioFiles").addEventListener("change", event => { addTracks(event.target.files); event.target.value = ""; });
  $("#replaceAudio").addEventListener("change", event => {
    const file = event.target.files?.[0]; if (!file || state.selected < 0) return;
    const track = currentTrack(); URL.revokeObjectURL(track.url);
    track.url = URL.createObjectURL(file); track.file = file; track.title = file.name.replace(/\.[^.]+$/, "");
    selectTrack(state.selected); renderTrackList(); event.target.value = "";
    notify("Đã thay file nhạc cho bài đang chọn.");
  });
  attachImageInput("discImageInput", "disc", url => { $(".record-label").style.backgroundImage = `url("${url}")`; $(".record-label").style.backgroundSize = "cover"; $(".record-label").style.backgroundPosition = "center"; });
  attachImageInput("squareImageInput", "square", url => { $("#coverPhoto").style.backgroundImage = `url("${url}")`; });
  attachImageInput("backgroundImageInput", "background", url => {
    $("#previewFrame").style.backgroundImage = `linear-gradient(#080a0d99,#080a0dcc),url("${url}")`;
    $("#previewFrame").style.backgroundSize = "cover"; $("#previewFrame").style.backgroundPosition = "center";
  });
  attachImageInput("logoInput", "logo", url => { $("#channelWatermark").style.backgroundImage = `url("${url}")`; });
  $("#backgroundVideoInput").addEventListener("change", event => { addScenes(event.target.files); event.target.value = ""; });
  $("#backgroundSceneImagesInput").addEventListener("change", event => { addScenes(event.target.files); event.target.value = ""; });
  $("#sceneFilesInput").addEventListener("change", event => { addScenes(event.target.files); event.target.value = ""; });
  $("#overlayInput").addEventListener("change", event => { if (event.target.files?.length) notify(`Đã thêm lớp phủ ${event.target.files[0].name}.`); event.target.value = ""; });
  $("#projectFile").addEventListener("change", event => { if (event.target.files?.[0]) openProject(event.target.files[0]); event.target.value = ""; });
  $("#lyricFileInput").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    state.subtitleLines = (await file.text()).split(/\r?\n/).filter(line => line.trim() && !/^\s*\d+\s*$/.test(line) && !/^\s*\d{2}:\d{2}/.test(line) && !/^\s*\[(verse|chorus|bridge)/i.test(line));
    state.subtitleMarks = [];
    const track = currentTrack();
    if (track) { track.lyrics = state.subtitleLines; track.lyricMarks = []; }
    renderPanel("lyrics"); updateTrackUI(); notify(`Đã nhập ${state.subtitleLines.length} dòng lời.`);
    event.target.value = "";
  });
  $("#openProject").addEventListener("click", () => $("#projectFile").click());
  $("#saveProject").addEventListener("click", saveProject);
  $("#exportVideo").addEventListener("click", exportVideo);
  $("#mobileMenu").addEventListener("click", () => $(".top-actions").classList.toggle("open"));
  $("#playPause").addEventListener("click", togglePlayback);
  $("#previousTrack").addEventListener("click", () => state.tracks.length && selectTrack((state.selected - 1 + state.tracks.length) % state.tracks.length));
  $("#nextTrack").addEventListener("click", () => state.tracks.length && selectTrack((state.selected + 1) % state.tracks.length));
  $("#restartTrack").addEventListener("click", () => { audio.currentTime = 0; updateTrackUI(); });
  $("#seekBar").addEventListener("input", event => {
    if (audio.duration) audio.currentTime = audio.duration * Number(event.target.value) / 100;
  });
  audio.addEventListener("timeupdate", updateTrackUI);
  audio.addEventListener("loadedmetadata", updateTrackUI);
  audio.addEventListener("ended", () => {
    document.body.classList.remove("is-playing"); $("#playIcon").textContent = "▶";
    if (exportInProgress) return;
    if (state.autoNext && state.tracks.length > 1) selectTrack((state.selected + 1) % state.tracks.length);
  });
  audio.addEventListener("play", () => {
    document.body.classList.add("is-playing");
    syncRecordRotation();
    $("#playIcon").textContent = "Ⅱ";
    animateWave();
  });
  audio.addEventListener("pause", () => {
    document.body.classList.remove("is-playing");
    syncRecordRotation();
    $("#playIcon").textContent = "▶";
    cancelAnimationFrame(waveAnimationFrame);
    applyWaveSettings();
  });
  document.addEventListener("keydown", event => {
    if (event.target.matches("input, textarea, select, button")) return;
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
    if (event.code === "Enter" && state.activeTab === "lyrics") { event.preventDefault(); markLyric(); }
  });
  document.addEventListener("dragover", event => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); });
  document.addEventListener("drop", event => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    addTracks(files);
  });
}

function togglePlayback() {
  if (!currentTrack()?.url) return notify("Thêm một bài hát để bắt đầu nghe thử.");
  if (!audio.paused) {
    audio.pause();
    return;
  }
  try {
    const context = ensureAudioAnalyser();
    context.resume().then(() => audio.play()).catch(() => notify("Không thể khởi động phân tích âm thanh. Hãy thử lại."));
  } catch (error) {
    notify(error.message || "Không thể phân tích âm thanh trong trình duyệt này.");
    audio.play().catch(() => notify("Không thể phát file âm thanh này."));
  }
}

function addScenes(files) {
  const added = [...files].filter(file => file.type.startsWith("image/") || file.type.startsWith("video/"));
  if (!added.length) return;
  state.scenes.push(...added.map(file => ({ name: file.name, url: URL.createObjectURL(file) })));
  renderSceneList();
  notify(`Đã thêm ${added.length} cảnh nền.`);
}

function renderSceneList() {
  const sceneList = $("#sceneList", panels);
  if (sceneList) sceneList.innerHTML = state.scenes.length
    ? state.scenes.map((scene, index) => `<div class="scene-item"><span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(scene.name)}</span><button class="track-remove" data-scene-remove="${index}" aria-label="Xóa cảnh">×</button></div>`).join("")
    : `<div class="empty-state">Chọn nhiều ảnh hoặc video để bắt đầu</div>`;
  $$("[data-scene-remove]", panels).forEach(button => button.addEventListener("click", () => {
    const index = Number(button.dataset.sceneRemove); URL.revokeObjectURL(state.scenes[index].url); state.scenes.splice(index, 1); renderPanel("background");
  }));
}

init();
