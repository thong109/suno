const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const video = $("#sourceVideo");
const state = {
  videoUrl: "",
  videoName: "",
  backgroundUrl: "",
  backgroundImage: null,
  cues: [],
  selectedCue: 0,
  plainLyrics: "",
  explicitTiming: false,
  exporting: false,
  settings: {
    videoSide: "left",
    videoFit: "cover",
    videoSize: 48,
    videoHeight: 68,
    borderWidth: 3,
    borderColor: "#e8b65f",
    borderRadius: 18,
    backgroundColor: "#101116",
    backgroundDim: 34,
    fontFamily: "sans",
    fontSize: 35,
    lyricColor: "#d8d9de",
    highlightColor: "#ffd477",
    lineSpacing: 17,
    wordHighlight: true,
    songTitle: "Tên bài hát",
    artistName: "",
    titleFontFamily: "serif",
    titleFontSize: 28,
    artistFontFamily: "sans",
    artistFontSize: 15
  }
};

let toastTimer;
let animationFrame = 0;
let recorder = null;
let recorderChunks = [];
let backgroundImageElement = null;
let videoCaptureStream = null;
let lastScrolledCue = -1;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(remaining)).padStart(2, "0")}.${String(Math.floor((remaining % 1) * 10))}`;
}

function parseTimestamp(value) {
  const match = String(value).match(/(\d{1,2}):(\d{2})(?:[.,:](\d{1,3}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || 0}`);
}

function parseLyrics(text) {
  if (text.includes("-->")) return parseSrt(text);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const cues = [];
  for (const line of lines) {
    const lrc = [...line.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (lrc.length) {
      const lyric = line.replace(/\[[^\]]+\]/g, "").trim();
      if (lyric) lrc.forEach(match => cues.push({ text: lyric, start: parseTimestamp(match[1]), end: null }));
      continue;
    }
  }
  if (cues.length) {
    cues.sort((a, b) => a.start - b.start);
    return cues.map((cue, index) => ({ text: cue.text, start: cue.start, end: cue.end ?? cues[index + 1]?.start ?? null }));
  }
  return lines.filter(line => !/^\d+$/.test(line)).map(text => ({ text, start: null, end: null }));
}

function parseSrtTimestamp(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`) : null;
}

function parseSrt(text) {
  const cues = [];
  const blocks = text.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const timeLine = lines.find(line => line.includes("-->"));
    if (!timeLine) {
      const lyric = lines.filter(line => !/^\d+$/.test(line)).join(" ").trim();
      if (lyric && !/^\d{1,2}:\d{2}/.test(lyric)) cues.push({ text: lyric, start: null, end: null });
      continue;
    }
    const match = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!match) continue;
    const textStart = lines.indexOf(timeLine) + 1;
    const lyric = lines.slice(textStart).filter(line => !/^\{\\an\d\}/.test(line)).join(" ").trim();
    if (lyric) cues.push({ text: lyric, start: parseSrtTimestamp(match[1]), end: parseSrtTimestamp(match[2]) });
  }
  return cues;
}

function distributeUntimedLyrics() {
  if (state.explicitTiming || !Number.isFinite(video.duration) || !video.duration || !state.cues.length) return;
  const interval = video.duration / state.cues.length;
  state.cues = state.cues.map((cue, index) => ({ ...cue, start: index * interval, end: (index + 1) * interval }));
  renderCueList();
}

function updateLyricsFromInput() {
  state.plainLyrics = $("#lyricsInput").value;
  state.cues = parseLyrics(state.plainLyrics);
  state.explicitTiming = state.cues.some(cue => cue.start !== null);
  state.selectedCue = 0;
  if (!state.explicitTiming) distributeUntimedLyrics();
  renderCueList();
  renderStageLyrics();
}

function syncSettings() {
  const root = $("#stage");
  root.style.setProperty("--video-size", `${state.settings.videoSize}%`);
  root.style.setProperty("--video-height", `${state.settings.videoHeight}%`);
  root.style.setProperty("--video-border", `${state.settings.borderWidth}px`);
  root.style.setProperty("--border-color", state.settings.borderColor);
  root.style.setProperty("--video-radius", `${state.settings.borderRadius}px`);
  root.style.setProperty("--video-fit", state.settings.videoFit);
  root.style.setProperty("--lyric-color", state.settings.lyricColor);
  root.style.setProperty("--highlight-color", state.settings.highlightColor);
  root.style.setProperty("--line-height", `${state.settings.lineSpacing / 10}`);
  $("#stageContent").classList.toggle("video-right", state.settings.videoSide === "right");
  $("#stageBackground").style.backgroundColor = state.settings.backgroundColor;
  $("#stageBackground").style.backgroundImage = state.backgroundUrl
    ? `url("${state.backgroundUrl}")`
    : `radial-gradient(ellipse at 70% 35%, #28231b, ${state.settings.backgroundColor} 68%)`;
  $("#stageBackground").style.filter = `brightness(${1 - state.settings.backgroundDim / 130})`;
  $("#stageBackground").style.backgroundSize = "cover";
  $("#stageBackground").style.backgroundPosition = "center";
  $("#lyricPanel").style.fontFamily = state.settings.fontFamily === "serif" ? '"Playfair Display",serif' : '"DM Sans",sans-serif';
  $("#songTitlePreview").textContent = state.settings.songTitle || "Tên bài hát";
  $("#stageArtist").textContent = state.settings.artistName;
  $("#songTitlePreview").style.fontFamily = state.settings.titleFontFamily === "serif" ? '"Playfair Display",serif' : '"DM Sans",sans-serif';
  $("#songTitlePreview").style.fontSize = `${state.settings.titleFontSize}px`;
  $("#stageArtist").style.fontFamily = state.settings.artistFontFamily === "serif" ? '"Playfair Display",serif' : '"DM Sans",sans-serif';
  $("#stageArtist").style.fontSize = `${state.settings.artistFontSize}px`;
  $("#stage").style.setProperty("--lyric-font-size", `${state.settings.fontSize}px`);
  renderStageLyrics();
}

function wordProgress(cue, time) {
  if (!state.settings.wordHighlight || cue.start === null || cue.start === undefined) return time >= (cue.start || 0) ? 1 : 0;
  const duration = Math.max(0.1, (cue.end ?? cue.start + 4) - cue.start);
  const elapsed = Math.max(0, time - cue.start);
  return Math.min(1, elapsed / duration);
}

function getActiveCueIndex(time = video.currentTime || 0) {
  if (!video.src || !state.cues.length || state.cues.every(cue => cue.start === null || cue.start === undefined)) return -1;
  let active = -1;
  state.cues.forEach((cue, index) => {
    const start = cue.start ?? 0;
    const end = cue.end ?? state.cues[index + 1]?.start ?? Infinity;
    if (time >= start && time < end) active = index;
  });
  if (active < 0) {
    for (let index = state.cues.length - 1; index >= 0; index--) {
      if ((state.cues[index].start ?? 0) <= time) { active = index; break; }
    }
  }
  return active;
}

function renderWordSpans(text, progress, enabled = true) {
  const words = text.split(/(\s+)/);
  const wordCount = words.filter(word => word.trim()).length;
  let wordIndex = 0;
  return words.map(word => {
    if (!word.trim()) return document.createTextNode(word);
    const isSung = enabled && wordIndex < Math.ceil(progress * wordCount);
    const span = document.createElement("span");
    span.className = `karaoke-word${isSung ? " sung" : ""}`;
    span.textContent = word;
    wordIndex++;
    return span;
  });
}

function renderStageLyrics() {
  const container = $("#stageLyrics");
  const activeIndex = getActiveCueIndex();
  if (!state.cues.length) {
    container.innerHTML = `<p class="stage-placeholder">Lời bài hát sẽ hiện ở đây</p>`;
    return;
  }
  const start = Math.max(0, Math.min(state.cues.length - 3, activeIndex < 0 ? 0 : activeIndex - 1));
  const visible = state.cues.slice(start, start + 4);
  container.replaceChildren(...visible.map((cue, offset) => {
    const index = start + offset;
    const paragraph = document.createElement("p");
    paragraph.className = index === activeIndex ? "active" : index < activeIndex ? "past" : "upcoming";
    const previewFontSize = state.settings.fontSize * $("#stage").clientWidth / 1920;
    paragraph.style.fontSize = `${Math.max(8, previewFontSize * (index === activeIndex ? 1 : 0.78))}px`;
    paragraph.append(...renderWordSpans(
      cue.text,
      index === activeIndex ? wordProgress(cue, video.currentTime || 0) : (index < activeIndex ? 1 : 0),
      state.settings.wordHighlight
    ));
    return paragraph;
  }));
  $("#lyricProgress").style.width = activeIndex < 0 ? "0%" : `${wordProgress(state.cues[activeIndex], video.currentTime || 0) * 100}%`;
  $$(".cue-row", $("#cueList")).forEach((row, index) => row.classList.toggle("active", index === activeIndex));
}

function renderCueList() {
  const list = $("#cueList");
  $("#cueCount").textContent = `${state.cues.length} câu`;
  if (!state.cues.length) {
    list.innerHTML = `<div class="empty-cues">Chưa có lyric. Dán lời hoặc nhập file để bắt đầu căn.</div>`;
    return;
  }
  list.innerHTML = state.cues.map((cue, index) => `
    <div class="cue-row ${index === state.selectedCue ? "selected" : ""}" data-cue="${index}">
      <span class="cue-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="cue-text" title="${escapeHtml(cue.text)}">${escapeHtml(cue.text)}</span>
      <label class="time-field"><small>VÀO</small><input data-time="start" type="number" min="0" step="0.1" value="${cue.start === null ? "" : cue.start.toFixed(1)}" placeholder="0.0" aria-label="Thời gian bắt đầu câu ${index + 1}"></label>
      <label class="time-field"><small>RA</small><input data-time="end" type="number" min="0" step="0.1" value="${cue.end === null ? "" : cue.end.toFixed(1)}" placeholder="tự động" aria-label="Thời gian kết thúc câu ${index + 1}"></label>
      <button type="button" data-remove-cue="${index}" aria-label="Xóa câu ${index + 1}">×</button>
    </div>`).join("");
  $$(".cue-row", list).forEach(row => {
    const index = Number(row.dataset.cue);
    row.addEventListener("click", event => {
      if (event.target.closest("input,button")) return;
      state.selectedCue = index;
      if (state.cues[index].start !== null) video.currentTime = state.cues[index].start;
      renderCueList();
      renderStageLyrics();
    });
    $$("input[data-time]", row).forEach(input => input.addEventListener("change", () => {
      const value = input.value === "" ? null : Math.max(0, Number(input.value));
      state.cues[index][input.dataset.time] = value;
      state.explicitTiming = true;
      renderStageLyrics();
    }));
  });
  $$("[data-remove-cue]", list).forEach(button => button.addEventListener("click", () => {
    state.cues.splice(Number(button.dataset.removeCue), 1);
    state.selectedCue = Math.min(state.selectedCue, Math.max(0, state.cues.length - 1));
    syncLyricsTextFromCues();
    renderCueList();
    renderStageLyrics();
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function syncLyricsTextFromCues() {
  state.plainLyrics = state.cues.map(cue => cue.text).join("\n");
  $("#lyricsInput").value = state.plainLyrics;
}

function markSelectedCue() {
  if (!state.cues.length) return notify("Dán lời bài hát trước khi căn mốc.");
  const index = Math.min(state.selectedCue, state.cues.length - 1);
  state.cues[index].start = Number(video.currentTime.toFixed(1));
  if (index > 0 && state.cues[index - 1].end === null) state.cues[index - 1].end = state.cues[index].start;
  if (index + 1 < state.cues.length && state.cues[index].end !== null && state.cues[index].end <= state.cues[index].start) state.cues[index].end = null;
  state.explicitTiming = true;
  state.selectedCue = Math.min(index + 1, state.cues.length - 1);
  renderCueList();
  renderStageLyrics();
  notify(`Đã căn câu ${index + 1} tại ${formatTime(video.currentTime)}.`);
}

function loadVideo(file) {
  if (!file || !file.type.startsWith("video/")) return notify("Chọn tệp video MP4 hoặc WebM.");
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  state.videoName = file.name;
  video.src = state.videoUrl;
  video.load();
  $("#videoFileName").textContent = file.name;
  $("#videoEmpty").hidden = true;
  $("#stageLoader").hidden = false;
  notify("Đang nạp video…");
}

function loadBackground(file) {
  if (!file || !file.type.startsWith("image/")) return notify("Chọn tệp ảnh JPG, PNG hoặc WebP.");
  if (state.backgroundUrl) URL.revokeObjectURL(state.backgroundUrl);
  state.backgroundImage = file;
  state.backgroundUrl = URL.createObjectURL(file);
  backgroundImageElement = new Image();
  backgroundImageElement.onload = () => syncSettings();
  backgroundImageElement.onerror = () => notify("Không thể đọc ảnh nền.");
  backgroundImageElement.src = state.backgroundUrl;
  $("#backgroundName").textContent = file.name;
  $("#removeBackground").hidden = false;
  syncSettings();
  notify("Đã cập nhật ảnh nền toàn video.");
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Không thể đọc tệp ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function saveProject() {
  let backgroundImage = null;
  try {
    if (state.backgroundImage) backgroundImage = await fileAsDataUrl(state.backgroundImage);
  } catch (error) {
    return notify(error.message);
  }
  const project = {
    version: 1,
    videoName: state.videoName,
    cues: state.cues,
    explicitTiming: state.explicitTiming,
    settings: state.settings,
    backgroundImage
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(state.settings.songTitle || "karaoke")}-project.json`);
  notify("Đã lưu dự án. Khi mở lại, chọn lại video nguồn để phát và xuất.");
}

async function openProject(file) {
  try {
    const project = JSON.parse(await file.text());
    if (!project || !Array.isArray(project.cues) || !project.settings) throw new Error("Tệp dự án karaoke không đúng định dạng.");
    state.cues = project.cues.map(cue => ({ text: String(cue.text || ""), start: cue.start ?? null, end: cue.end ?? null }));
    state.explicitTiming = Boolean(project.explicitTiming);
    state.videoName = project.videoName || "";
    state.settings = { ...state.settings, ...project.settings };
    $("#lyricsInput").value = state.cues.map(cue => cue.text).join("\n");
    syncControlsFromState();
    if (project.backgroundImage) {
      const response = await fetch(project.backgroundImage);
      if (!response.ok) throw new Error("Không thể khôi phục ảnh nền từ dự án.");
      const backgroundBlob = await response.blob();
      loadBackground(new File([backgroundBlob], "karaoke-background", { type: backgroundBlob.type || "image/png" }));
    }
    renderCueList();
    syncSettings();
    notify("Đã mở dự án. Chọn lại video nguồn để xem trước.");
  } catch (error) {
    notify(error.message || "Không thể mở dự án.");
  }
}

function syncControlsFromState() {
  Object.entries({
    videoSide: "videoSide", videoFit: "videoFit", videoSize: "videoSize", videoHeight: "videoHeight", borderWidth: "borderWidth",
    borderColor: "borderColor", borderRadius: "borderRadius", backgroundColor: "backgroundColor",
    backgroundDim: "backgroundDim", fontFamily: "fontFamily", fontSize: "fontSize",
    titleFontFamily: "titleFontFamily", titleFontSize: "titleFontSize",
    artistFontFamily: "artistFontFamily", artistFontSize: "artistFontSize",
    lyricColor: "lyricColor", highlightColor: "highlightColor", lineSpacing: "lineSpacing",
    wordHighlight: "wordHighlight", songTitle: "songTitle", artistName: "artistName"
  }).forEach(([id, key]) => { $(`#${id}`).value = state.settings[key]; });
  updateOutputs();
}

function updateOutputs() {
  $("#videoSizeValue").textContent = `${state.settings.videoSize}%`;
  $("#videoHeightValue").textContent = `${state.settings.videoHeight}%`;
  $("#borderWidthValue").textContent = `${state.settings.borderWidth} px`;
  $("#borderRadiusValue").textContent = `${state.settings.borderRadius} px`;
  $("#backgroundDimValue").textContent = `${state.settings.backgroundDim}%`;
  $("#fontSizeValue").textContent = `${state.settings.fontSize} px`;
  $("#titleFontSizeValue").textContent = `${state.settings.titleFontSize} px`;
  $("#artistFontSizeValue").textContent = `${state.settings.artistFontSize} px`;
  $("#lineSpacingValue").textContent = (state.settings.lineSpacing / 10).toFixed(1);
}

function safeFilename(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "-").trim() || "karaoke-video";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function drawCoverImage(context, image, x, y, width, height, fit = "cover") {
  const sourceWidth = image.videoWidth || image.naturalWidth;
  const sourceHeight = image.videoHeight || image.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight;
  let dx = x, dy = y, dw = width, dh = height;
  if (fit === "cover") {
    if (sourceRatio > targetRatio) {
      sw = sourceHeight * targetRatio;
      sx = (sourceWidth - sw) / 2;
    } else {
      sh = sourceWidth / targetRatio;
      sy = (sourceHeight - sh) / 2;
    }
  } else if (sourceRatio > targetRatio) {
    dh = width / sourceRatio;
    dy += (height - dh) / 2;
  } else {
    dw = height * sourceRatio;
    dx += (width - dw) / 2;
  }
  context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function wrapText(context, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function drawKaraokeText(context, cue, x, y, maxWidth, fontSize, progress, options = {}) {
  const font = state.settings.fontFamily === "serif" ? "Georgia, serif" : "Arial, sans-serif";
  context.font = `${options.bold ? "700" : "500"} ${fontSize}px ${font}`;
  context.textBaseline = "middle";
  context.textAlign = "left";
  const words = cue.text.split(/\s+/).filter(Boolean);
  let lines = wrapText(context, cue.text, maxWidth);
  if (lines.length > 3) {
    const fittingWords = [];
    for (const word of words) {
      fittingWords.push(word);
      if (wrapText(context, fittingWords.join(" "), maxWidth).length > 3) {
        fittingWords.pop();
        break;
      }
    }
    lines = wrapText(context, fittingWords.join(" "), maxWidth);
  }
  const wordThreshold = state.settings.wordHighlight ? Math.ceil(progress * words.length) : 0;
  let wordCursor = 0;
  const lineHeight = fontSize * 1.48;
  lines.forEach((line, lineIndex) => {
    const lineWords = line.split(/\s+/).filter(Boolean);
    const lineWidth = context.measureText(line).width;
    let cursorX = x + (options.center ? (maxWidth - lineWidth) / 2 : 0);
    const yPosition = y + lineIndex * lineHeight;
    lineWords.forEach((word, wordIndex) => {
      context.fillStyle = wordCursor < wordThreshold ? state.settings.highlightColor : state.settings.lyricColor;
      if (wordCursor < wordThreshold) {
        context.shadowColor = `${state.settings.highlightColor}a8`;
        context.shadowBlur = fontSize * 0.3;
      } else context.shadowBlur = 0;
      context.fillText(word, cursorX, yPosition);
      cursorX += context.measureText(word).width;
      if (wordIndex < lineWords.length - 1) {
        cursorX += context.measureText(" ").width;
      }
      wordCursor++;
    });
  });
  context.shadowBlur = 0;
  return lines.length * lineHeight;
}

function drawExportFrame(context, width, height) {
  context.fillStyle = state.settings.backgroundColor;
  context.fillRect(0, 0, width, height);
  if (backgroundImageElement?.complete && backgroundImageElement.naturalWidth) {
    drawCoverImage(context, backgroundImageElement, 0, 0, width, height, "cover");
  }
  const dim = Number(state.settings.backgroundDim) / 100;
  if (dim > 0) {
    context.fillStyle = `rgba(5,6,9,${dim})`;
    context.fillRect(0, 0, width, height);
  }
  const horizontalPadding = width * 0.055;
  const videoWidth = width * state.settings.videoSize / 100;
  const videoHeight = height * state.settings.videoHeight / 100;
  const side = state.settings.videoSide;
  const videoX = side === "left" ? horizontalPadding : width - horizontalPadding - videoWidth;
  const videoY = height * 0.58 - videoHeight / 2;
  const border = Number(state.settings.borderWidth) * width / 1280;
  const radius = Number(state.settings.borderRadius) * width / 1280;
  roundedRect(context, videoX, videoY, videoWidth, videoHeight, radius);
  context.save();
  context.clip();
  if (video.readyState >= 2) drawCoverImage(context, video, videoX, videoY, videoWidth, videoHeight, state.settings.videoFit);
  else {
    context.fillStyle = "#0a0b0f";
    context.fillRect(videoX, videoY, videoWidth, videoHeight);
  }
  context.restore();
  if (border > 0) {
    roundedRect(context, videoX + border / 2, videoY + border / 2, videoWidth - border, videoHeight - border, radius);
    context.strokeStyle = state.settings.borderColor;
    context.lineWidth = border;
    context.shadowColor = state.settings.borderColor;
    context.shadowBlur = border * 4;
    context.stroke();
    context.shadowBlur = 0;
  }
  const textX = side === "left" ? width * 0.55 : horizontalPadding;
  const textWidth = width * 0.39;
  const center = true;
  const titleFont = state.settings.titleFontFamily === "serif" ? '"Playfair Display", Georgia, serif' : '"DM Sans", Arial, sans-serif';
  const artistFont = state.settings.artistFontFamily === "serif" ? '"Playfair Display", Georgia, serif' : '"DM Sans", Arial, sans-serif';
  context.textAlign = "center";
  context.fillStyle = "#f4f1e9";
  context.font = `500 ${width * Number(state.settings.titleFontSize) / 1280}px ${titleFont}`;
  context.fillText(state.settings.songTitle || "Tên bài hát", width / 2, height * 0.09, width * 0.84);
  if (state.settings.artistName) {
    context.fillStyle = "#c3c4ca";
    context.font = `400 ${width * Number(state.settings.artistFontSize) / 1280}px ${artistFont}`;
    context.fillText(state.settings.artistName, width / 2, height * 0.135, width * 0.84);
  }
  const active = getActiveCueIndex(video.currentTime);
  const firstCue = Math.max(0, Math.min(state.cues.length - 4, active < 0 ? 0 : active - 1));
  const previewCues = state.cues.slice(firstCue, firstCue + 4);
  const baseFont = width * Number(state.settings.fontSize) / 1280;
  let lyricY = height * 0.31;
  previewCues.forEach((cue, index) => {
    const cueIndex = firstCue + index;
    const isActive = cueIndex === active;
    const isPast = cueIndex < active;
    const opacity = isActive ? 1 : isPast ? 0.34 : 0.52;
    context.globalAlpha = opacity;
    const cueProgress = isActive ? wordProgress(cue, video.currentTime) : (isPast ? 1 : 0);
    const fontSize = baseFont * (isActive ? 1 : 0.78);
    const textHeight = drawKaraokeText(context, cue, textX, lyricY, textWidth, fontSize, cueProgress, { center, bold: isActive });
    lyricY += Math.max(textHeight, fontSize * 1.55) + height * 0.035;
  });
  context.globalAlpha = 1;
  context.textAlign = "left";
}

function updatePlaybackUI() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const current = video.currentTime || 0;
  $("#currentTime").textContent = formatTime(current);
  $("#totalTime").textContent = formatTime(duration);
  $("#seekBar").value = duration ? String(Math.round(current / duration * 1000)) : "0";
  renderStageLyrics();
  const active = getActiveCueIndex(current);
  if (active >= 0) state.selectedCue = active;
  const activeRow = $(`.cue-row[data-cue="${active}"]`);
  if (activeRow && !video.paused && active !== lastScrolledCue) {
    activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    lastScrolledCue = active;
  }
}

function handleVideoLoaded() {
  $("#stageLoader").hidden = true;
  $("#videoEmpty").hidden = true;
  $("#totalTime").textContent = formatTime(video.duration);
  if (!state.explicitTiming) distributeUntimedLyrics();
  updatePlaybackUI();
  notify(`Đã tải video · ${formatTime(video.duration)}.`);
}

function renderCanvasLoop(canvas, context) {
  const draw = () => {
    drawExportFrame(context, canvas.width, canvas.height);
    if (state.exporting) animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function exportVideo() {
  if (state.exporting) {
    if (recorder?.state === "recording") recorder.stop();
    return;
  }
  if (!state.videoUrl || !video.videoWidth) return notify("Tải video nguồn trước khi xuất.");
  const capture = video.captureStream || video.mozCaptureStream;
  if (!capture || !window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    return notify("Xuất video cần Chrome hoặc Edge mới để ghi hình WebM.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext("2d");
  const videoStream = canvas.captureStream(30);
  const button = $("#exportVideo");
  button.disabled = true;
  button.textContent = "Đang chuẩn bị…";
  try {
    video.pause();
    video.currentTime = 0;
    await video.play();
    videoCaptureStream = capture.call(video);
    const audioTracks = videoCaptureStream.getAudioTracks();
    audioTracks.forEach(track => videoStream.addTrack(track));
    if (!audioTracks.length) notify("Video không có âm thanh nên file xuất sẽ ở chế độ im lặng.");
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("Trình duyệt này không hỗ trợ xuất WebM.");
    recorderChunks = [];
    recorder = new MediaRecorder(videoStream, { mimeType, videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = event => { if (event.data.size) recorderChunks.push(event.data); };
    recorder.onerror = event => {
      state.exporting = false;
      cancelAnimationFrame(animationFrame);
      video.pause();
      videoCaptureStream?.getTracks().forEach(track => track.stop());
      videoStream.getTracks().forEach(track => track.stop());
      button.disabled = false;
      button.innerHTML = "Xuất video <span>↗</span>";
      notify(event.error?.message || "Có lỗi khi ghi video.");
    };
    recorder.onstop = () => {
      cancelAnimationFrame(animationFrame);
      if (recorderChunks.length) {
        downloadBlob(new Blob(recorderChunks, { type: mimeType }), `${safeFilename(state.settings.songTitle)}.webm`);
        notify("Xuất video WebM hoàn tất.");
      }
      state.exporting = false;
      video.pause();
      videoCaptureStream?.getTracks().forEach(track => track.stop());
      videoStream.getTracks().forEach(track => track.stop());
      button.disabled = false;
      button.innerHTML = "Xuất video <span>↗</span>";
    };
    state.exporting = true;
    button.textContent = "Dừng xuất";
    recorder.start(1000);
    renderCanvasLoop(canvas, context);
    notify("Đang xuất video · giữ trang mở đến khi tải xong.");
  } catch (error) {
    state.exporting = false;
    video.pause();
    videoCaptureStream?.getTracks().forEach(track => track.stop());
    videoStream.getTracks().forEach(track => track.stop());
    button.disabled = false;
    button.innerHTML = "Xuất video <span>↗</span>";
    notify(error.message || "Không thể xuất video.");
  }
}

function bindRange(id, key, output, suffix = "") {
  const input = $(`#${id}`);
  input.addEventListener("input", () => {
    state.settings[key] = Number(input.value);
    if (output) $(output).textContent = `${input.value}${suffix}`;
    syncSettings();
  });
}

function bindColor(id, key) {
  $(`#${id}`).addEventListener("input", event => {
    state.settings[key] = event.target.value;
    syncSettings();
  });
}

function init() {
  syncSettings();
  $("#chooseVideo").addEventListener("click", () => $("#videoFile").click());
  $("#videoFile").addEventListener("change", event => {
    loadVideo(event.target.files?.[0]);
    event.target.value = "";
  });
  $("#chooseBackground").addEventListener("click", () => $("#backgroundFile").click());
  $("#backgroundFile").addEventListener("change", event => {
    loadBackground(event.target.files?.[0]);
    event.target.value = "";
  });
  $("#removeBackground").addEventListener("click", () => {
    if (state.backgroundUrl) URL.revokeObjectURL(state.backgroundUrl);
    state.backgroundUrl = "";
    state.backgroundImage = null;
    backgroundImageElement = null;
    $("#backgroundName").textContent = "Chưa chọn ảnh nền";
    $("#removeBackground").hidden = true;
    syncSettings();
  });
  $("#lyricsFile").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then(text => {
      $("#lyricsInput").value = text;
      updateLyricsFromInput();
      notify(`Đã nhập lời từ ${file.name}.`);
    }).catch(() => notify("Không thể đọc tệp lời bài hát."));
    event.target.value = "";
  });
  $("#importLyrics").addEventListener("click", () => $("#lyricsFile").click());
  $("#lyricsInput").addEventListener("input", updateLyricsFromInput);
  $("#addCue").addEventListener("click", () => {
    state.cues.push({ text: "Câu hát mới", start: video.currentTime || 0, end: null });
    state.selectedCue = state.cues.length - 1;
    state.explicitTiming = true;
    syncLyricsTextFromCues();
    renderCueList();
    renderStageLyrics();
  });
  $("#markCue").addEventListener("click", markSelectedCue);
  $("#clearLyrics").addEventListener("click", () => {
    state.cues = [];
    state.plainLyrics = "";
    state.explicitTiming = false;
    $("#lyricsInput").value = "";
    renderCueList();
    renderStageLyrics();
    notify("Đã xóa lời bài hát.");
  });
  $("#videoSide").addEventListener("change", event => { state.settings.videoSide = event.target.value; syncSettings(); });
  $("#videoFit").addEventListener("change", event => { state.settings.videoFit = event.target.value; syncSettings(); });
  bindRange("videoSize", "videoSize", "#videoSizeValue", "%");
  bindRange("videoHeight", "videoHeight", "#videoHeightValue", "%");
  bindRange("borderWidth", "borderWidth", "#borderWidthValue", " px");
  bindRange("borderRadius", "borderRadius", "#borderRadiusValue", " px");
  bindRange("backgroundDim", "backgroundDim", "#backgroundDimValue", "%");
  bindRange("fontSize", "fontSize", "#fontSizeValue", " px");
  bindRange("titleFontSize", "titleFontSize", "#titleFontSizeValue", " px");
  bindRange("artistFontSize", "artistFontSize", "#artistFontSizeValue", " px");
  bindRange("lineSpacing", "lineSpacing", "#lineSpacingValue");
  bindColor("borderColor", "borderColor");
  bindColor("backgroundColor", "backgroundColor");
  bindColor("lyricColor", "lyricColor");
  bindColor("highlightColor", "highlightColor");
  $("#fontFamily").addEventListener("change", event => { state.settings.fontFamily = event.target.value; syncSettings(); });
  $("#titleFontFamily").addEventListener("change", event => { state.settings.titleFontFamily = event.target.value; syncSettings(); });
  $("#artistFontFamily").addEventListener("change", event => { state.settings.artistFontFamily = event.target.value; syncSettings(); });
  $("#wordHighlight").addEventListener("change", event => { state.settings.wordHighlight = event.target.checked; syncSettings(); });
  $("#songTitle").addEventListener("input", event => { state.settings.songTitle = event.target.value; syncSettings(); });
  $("#artistName").addEventListener("input", event => { state.settings.artistName = event.target.value; syncSettings(); });
  $("#playPause").addEventListener("click", () => {
    if (!state.videoUrl) return notify("Tải video lên trước khi phát.");
    if (video.paused) video.play().catch(() => notify("Không phát được video này."));
    else video.pause();
  });
  $("#restartVideo").addEventListener("click", () => { video.currentTime = 0; updatePlaybackUI(); });
  $("#seekBar").addEventListener("input", event => {
    if (Number.isFinite(video.duration)) video.currentTime = video.duration * Number(event.target.value) / 1000;
  });
  video.addEventListener("loadedmetadata", handleVideoLoaded);
  video.addEventListener("loadeddata", () => { $("#stageLoader").hidden = true; });
  video.addEventListener("timeupdate", updatePlaybackUI);
  video.addEventListener("play", () => { $("#playPause").textContent = "Ⅱ"; });
  video.addEventListener("pause", () => { $("#playPause").textContent = "▶"; });
  video.addEventListener("error", () => { $("#stageLoader").hidden = true; notify("Video không hỗ trợ được. Hãy thử tệp MP4 hoặc WebM."); });
  video.addEventListener("ended", () => {
    if (state.exporting && recorder?.state === "recording") recorder.stop();
  });
  $("#saveProject").addEventListener("click", saveProject);
  $("#openProject").addEventListener("click", () => $("#projectFile").click());
  $("#exportVideo").addEventListener("click", exportVideo);
  $("#projectFile").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) openProject(file);
    event.target.value = "";
  });
  $("#mobileMenu").addEventListener("click", () => $(".topbar-actions").classList.toggle("open"));
  document.addEventListener("keydown", event => {
    if (event.target.matches("input, textarea, select, button, a")) return;
    if (event.code === "Space") { event.preventDefault(); $("#playPause").click(); }
    if (event.code === "Enter") { event.preventDefault(); markSelectedCue(); }
  });
  document.addEventListener("dragover", event => {
    if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", event => {
    const file = [...(event.dataTransfer?.files || [])].find(item => item.type.startsWith("video/"));
    if (!file) return;
    event.preventDefault();
    loadVideo(file);
  });
  $("#cueList").innerHTML = `<div class="empty-cues">Chưa có lyric. Dán lời hoặc nhập file để bắt đầu căn.</div>`;
}

init();
