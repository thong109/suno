const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  tracks: [],
  bpm: 72,
  beatsPerBar: 4,
  bars: 8,
  playhead: 0,
  playing: false,
  recording: false,
  micStream: null,
  recorder: null,
  nodes: new Set(),
  aiConfigured: false,
  settings: { masterVolume: 0.85, beatStyle: "bolero", beatEnergy: 2, musicKey: "C", chordPattern: "bolero" }
};
const colors = { voice: "#e28378", audio: "#7c9fe0", beat: "#e0ad58", pad: "#a98bd4", bass: "#69b9a2" };
let audioContext = null;
let masterGain = null;
let playbackStartedAt = 0;
let playbackStartPosition = 0;
let playTimer = 0;
let toastTimer = 0;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(Math.floor(safe % 60)).padStart(2, "0")}.${Math.floor((safe % 1) * 10)}`;
}

function safeFilename(value) {
  return String(value || "music-project").replace(/[\\/:*?"<>|]/g, "-").trim() || "music-project";
}

function getAudioContext() {
  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("Trình duyệt không hỗ trợ Web Audio. Hãy thử Chrome hoặc Edge mới.");
    audioContext = new Context();
    masterGain = audioContext.createGain();
    masterGain.gain.value = state.settings.masterVolume;
    masterGain.connect(audioContext.destination);
  }
  return audioContext;
}

function getProjectDuration() {
  return Math.max(
    0,
    ...state.tracks.map(track => track.start + (track.buffer?.duration || track.duration || 0)),
    state.bars * state.beatsPerBar * 60 / state.bpm
  );
}

function timelineScale() {
  return 66;
}

function renderRuler() {
  const ruler = $("#timelineRuler");
  const seconds = getProjectDuration();
  const barDuration = state.beatsPerBar * 60 / state.bpm;
  const barCount = Math.max(state.bars, Math.ceil(seconds / barDuration));
  ruler.style.width = `${Math.max(480, barCount * barDuration * timelineScale())}px`;
  ruler.innerHTML = Array.from({ length: barCount + 1 }, (_, index) => {
    const minute = Math.floor(index * barDuration / 60);
    const second = Math.floor(index * barDuration % 60);
    const label = index % 2 === 0 ? `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` : `BAR ${index + 1}`;
    return `<span>${label}</span>`;
  }).join("");
  $$(".ruler span", ruler).forEach((span, index) => { span.style.flex = `0 0 ${barDuration * timelineScale()}px`; });
}

function renderTimeline() {
  renderRuler();
  const duration = Math.max(getProjectDuration(), 8);
  const scale = timelineScale();
  const list = $("#trackList");
  list.innerHTML = state.tracks.map(track => {
    const trackDuration = track.buffer?.duration || track.duration || 1;
    const left = Math.max(0, track.start * scale);
    const width = Math.max(24, trackDuration * scale);
    const unavailable = !track.buffer;
    return `<div class="track-row" data-track-row="${track.id}">
      <div class="track-meta" style="--track-color:${track.color}">
        <i class="track-color"></i><div class="track-meta-copy"><strong>${escapeHtml(track.name)}</strong><small>${unavailable ? "Cần chọn lại file" : `${formatTime(trackDuration)} · ${track.kind.toUpperCase()}`}</small></div>
        <button class="track-mute ${track.muted ? "muted" : ""}" data-mute="${track.id}" title="${track.muted ? "Bật track" : "Tắt track"}">${track.muted ? "M" : "S"}</button>
      </div>
      <div class="track-lane" data-lane="${track.id}" style="width:${Math.max(480,duration*scale)}px">
        <div class="lane-grid">${Array.from({length:Math.max(state.bars,Math.ceil(duration/(state.beatsPerBar*60/state.bpm)))},()=>"<i></i>").join("")}</div>
        <div class="clip ${track.generated ? "generated" : ""}" style="--clip-color:${track.color};left:${left}px;width:${width}px" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}${unavailable ? " · offline" : ""}</div>
      </div>
    </div>`;
  }).join("");
  $("#trackSummary").textContent = `${state.tracks.length} track${state.tracks.length === 1 ? "" : "s"}`;
  $("#emptyMixer").hidden = state.tracks.length > 0;
  const labelWidth = $(".track-label-spacer").getBoundingClientRect().width || 132;
  $("#playhead").style.left = `${labelWidth + state.playhead * scale}px`;
  renderMixer();
  $$(".track-mute").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const track = findTrack(button.dataset.mute);
    if (!track) return;
    track.muted = !track.muted;
    applyTrackGain(track);
    renderTimeline();
  }));
  $$(".track-lane").forEach(lane => lane.addEventListener("pointerdown", event => {
    const rect = lane.getBoundingClientRect();
    const scrollLeft = $(".timeline-scroll").scrollLeft;
    setPlayhead(Math.max(0, event.clientX - rect.left + scrollLeft) / scale);
  }));
}

function renderMixer() {
  $("#mixerList").innerHTML = state.tracks.map(track => `
    <div class="mixer-row" style="--track-color:${track.color}" data-mixer="${track.id}">
      <i class="mixer-swatch"></i>
      <div class="mixer-name">${escapeHtml(track.name)}<small>${track.buffer ? escapeHtml(track.fileName || (track.generated ? "Generated instrument" : "Audio clip")) : "Audio file missing"}</small></div>
      <label>VOL</label><input data-gain="${track.id}" type="range" min="0" max="150" value="${Math.round(track.volume*100)}" aria-label="${escapeHtml(track.name)} volume">
      <input data-start="${track.id}" type="number" min="0" step="0.1" value="${track.start.toFixed(1)}" aria-label="${escapeHtml(track.name)} start time">
      <button data-delete="${track.id}" aria-label="Remove ${escapeHtml(track.name)}">×</button>
    </div>`).join("");
  $$("[data-gain]").forEach(input => input.addEventListener("input", () => {
    const track = findTrack(input.dataset.gain);
    if (!track) return;
    track.volume = Number(input.value) / 100;
    applyTrackGain(track);
  }));
  $$("[data-start]").forEach(input => input.addEventListener("change", () => {
    const track = findTrack(input.dataset.start);
    if (!track) return;
    track.start = Math.max(0, Number(input.value) || 0);
    renderTimeline();
  }));
  $$("[data-delete]").forEach(button => button.addEventListener("click", () => removeTrack(button.dataset.delete)));
}

function findTrack(id) { return state.tracks.find(track => track.id === id); }

function applyTrackGain(track) {
  if (track.activeGain) track.activeGain.gain.setTargetAtTime(track.muted ? 0 : track.volume, audioContext.currentTime, 0.015);
}

function addTrack({ name, kind = "audio", buffer, fileName = "", generated = false, start = 0, duration = 0, volume = 0.85, muted = false }) {
  if (!buffer && !duration) throw new Error("Không thể thêm track không có audio.");
  const color = colors[kind] || colors.audio;
  const track = { id: crypto.randomUUID(), name, kind, buffer, fileName, generated, start, duration: buffer?.duration || duration, volume, muted, color };
  state.tracks.push(track);
  renderTimeline();
  return track;
}

function replaceGeneratedTrack(name, kind, buffer) {
  state.tracks = state.tracks.filter(track => !(track.generated && track.name === name));
  addTrack({ name, kind, buffer, generated: true });
}

async function importAudio(files) {
  const audioFiles = [...files].filter(file => file.type.startsWith("audio/") || /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(file.name));
  if (!audioFiles.length) return notify("Chọn file âm thanh WAV, MP3, M4A hoặc OGG.");
  const context = getAudioContext();
  for (const file of audioFiles) {
    try {
      const data = await file.arrayBuffer();
      const buffer = await context.decodeAudioData(data.slice(0));
      const unavailable = state.tracks.find(track => !track.buffer && track.fileName?.toLowerCase() === file.name.toLowerCase());
      if (unavailable) {
        unavailable.buffer = buffer;
        unavailable.duration = buffer.duration;
        unavailable.color = colors[unavailable.kind] || colors.audio;
        renderTimeline();
      } else {
        addTrack({ name: file.name.replace(/\.[^.]+$/, ""), kind: "audio", buffer, fileName: file.name });
      }
    } catch (error) {
      notify(`Không thể đọc ${file.name}: ${error.message || "định dạng không hỗ trợ"}`);
    }
  }
  notify(`Đã nạp ${audioFiles.length} file audio; file trùng tên được nối lại vào track dự án.`);
}

function createNoiseBuffer(context, duration = 0.35) {
  const length = Math.ceil(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
  return buffer;
}

function scheduleKick(context, destination, time, strength) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(145, time);
  oscillator.frequency.exponentialRampToValueAtTime(44, time + 0.16);
  gain.gain.setValueAtTime(Math.min(0.95, strength), time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
  oscillator.connect(gain).connect(destination);
  oscillator.start(time);
  oscillator.stop(time + 0.31);
}

function scheduleNoiseDrum(context, destination, noise, time, type, strength) {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = noise;
  filter.type = type === "hat" ? "highpass" : "highpass";
  filter.frequency.value = type === "hat" ? 7500 : 1300;
  const duration = type === "hat" ? 0.055 : 0.18;
  gain.gain.setValueAtTime(strength, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  source.connect(filter).connect(gain).connect(destination);
  source.start(time);
  source.stop(time + duration + 0.01);
}

async function renderOffline(duration, build) {
  const sampleRate = 44100;
  const frames = Math.ceil(duration * sampleRate);
  if (!frames || frames > sampleRate * 60 * 10) throw new Error("Độ dài bản nhạc cần từ 0 đến 10 phút.");
  const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Context) throw new Error("Trình duyệt chưa hỗ trợ render audio offline.");
  const offline = new Context(2, frames, sampleRate);
  build(offline, offline.destination, duration);
  return offline.startRendering();
}

async function generateBeat() {
  const bpm = state.bpm;
  const beats = state.beatsPerBar;
  const duration = state.bars * beats * 60 / bpm;
  const style = $("#beatStyle").value;
  const energy = Number($("#beatEnergy").value);
  const beatPatterns = {
    bolero: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
    pop: { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    hiphop: { kick: [0, 7, 10], snare: [4, 12], hat: [0, 3, 6, 8, 11, 14] },
    rock: { kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    lofi: { kick: [0, 10], snare: [4, 12], hat: [2, 6, 10, 14] },
    dance: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] }
  };
  const pattern = beats === 3
    ? { kick: [0, 6], snare: [4, 8], hat: [0, 2, 4, 6, 8, 10] }
    : (beatPatterns[style] || beatPatterns.pop);
  const quarter = 60 / bpm;
  const sixteenth = quarter / 4;
  const swing = style === "hiphop" || style === "lofi" ? 0.06 : style === "bolero" ? 0.025 : 0;
  notify("Đang tạo beat…");
  const buffer = await renderOffline(duration, (context, destination) => {
    const noise = createNoiseBuffer(context);
    const barCount = Math.ceil(duration / (beats * quarter));
    for (let bar = 0; bar < barCount; bar++) {
      for (let step = 0; step < beats * 4; step++) {
        const time = (bar * beats * quarter) + step * sixteenth + (step % 4 === 2 ? swing * quarter : 0);
        const accent = style === "bolero"
          ? (step % 4 === 0 ? 0.28 + energy * 0.045 : 0.14 + energy * 0.035)
          : (step % 4 === 0 ? 0.55 + energy * 0.085 : 0.32 + energy * 0.07);
        if (pattern.kick.includes(step)) scheduleKick(context, destination, time, accent);
        if (pattern.snare.includes(step)) scheduleNoiseDrum(context, destination, noise, time, "snare", style === "bolero" ? 0.09 + energy * 0.02 : 0.17 + energy * 0.035);
        if (pattern.hat.includes(step)) scheduleNoiseDrum(context, destination, noise, time, "hat", style === "bolero" ? 0.025 + energy * 0.008 : 0.045 + energy * 0.012);
      }
    }
  });
  replaceGeneratedTrack(`Beat · ${style}`, "beat", buffer);
  $("#playStatus").textContent = "BEAT SẴN SÀNG";
  notify("Đã tạo beat. Bấm Phát để nghe.");
}

function midiFrequency(note) { return 440 * (2 ** ((note - 69) / 12)); }

function rootMidi(key) {
  return ({ C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, Bb: 70 })[key] || 60;
}

const progressions = {
  bolero: [0, 5, 1, 4],
  pop: [0, 4, 5, 3],
  classic: [0, 5, 3, 4],
  minor: [5, 3, 0, 4],
  jazz: [1, 4, 0, 5]
};
const chordIntervals = { 0: [0, 4, 7], 1: [2, 5, 9], 2: [4, 7, 11], 3: [5, 9, 12], 4: [7, 11, 14], 5: [9, 12, 16], 6: [11, 14, 17] };

async function generateBacking() {
  const bpm = state.bpm;
  const beats = state.beatsPerBar;
  const duration = state.bars * beats * 60 / bpm;
  const root = rootMidi($("#musicKey").value);
  const progression = progressions[$("#chordPattern").value] || progressions.pop;
  const bolero = $("#chordPattern").value === "bolero" || $("#beatStyle").value === "bolero";
  const barDuration = beats * 60 / bpm;
  notify("Đang tạo đệm hợp âm…");
  const pad = await renderOffline(duration, (context, destination) => {
    const master = context.createGain();
    master.gain.value = 0.65;
    master.connect(destination);
    const bars = Math.ceil(duration / barDuration);
    for (let bar = 0; bar < bars; bar++) {
      const degree = progression[bar % progression.length];
      const notes = chordIntervals[degree].map(interval => root + interval + 12);
      const start = bar * barDuration;
      if (bolero) {
        for (const beat of [1, 2, 3]) {
          const pluckTime = start + beat * 60 / bpm;
          if (pluckTime >= duration) continue;
          notes.forEach((note, index) => {
            const oscillator = context.createOscillator();
            const filter = context.createBiquadFilter();
            const envelope = context.createGain();
            oscillator.type = "triangle";
            oscillator.frequency.value = midiFrequency(note + (index === 2 ? 12 : 0));
            filter.type = "lowpass";
            filter.frequency.value = 2400;
            envelope.gain.setValueAtTime(0.001, pluckTime);
            envelope.gain.linearRampToValueAtTime(index === 1 ? 0.075 : 0.06, pluckTime + 0.012);
            envelope.gain.exponentialRampToValueAtTime(0.001, pluckTime + 0.32);
            oscillator.connect(filter).connect(envelope).connect(master);
            oscillator.start(pluckTime);
            oscillator.stop(pluckTime + 0.34);
          });
        }
        continue;
      }
      const end = Math.min(duration, start + barDuration + 0.06);
      notes.forEach((note, index) => {
        const oscillator = context.createOscillator();
        const filter = context.createBiquadFilter();
        const envelope = context.createGain();
        oscillator.type = index === 1 ? "triangle" : "sine";
        oscillator.frequency.value = midiFrequency(note);
        filter.type = "lowpass";
        filter.frequency.value = 1500;
        envelope.gain.setValueAtTime(0.001, start);
        envelope.gain.linearRampToValueAtTime(0.11, start + 0.15);
        envelope.gain.setValueAtTime(0.085, Math.max(start + 0.16, end - 0.12));
        envelope.gain.linearRampToValueAtTime(0.001, end);
        oscillator.connect(filter).connect(envelope).connect(master);
        oscillator.start(start);
        oscillator.stop(end + 0.01);
      });
    }
  });
  const bass = await renderOffline(duration, (context, destination) => {
    const master = context.createGain();
    master.gain.value = 0.7;
    master.connect(destination);
    const bars = Math.ceil(duration / barDuration);
    for (let bar = 0; bar < bars; bar++) {
      const degree = progression[bar % progression.length];
      const rootNote = root + (chordIntervals[degree][0]) - 12;
      for (let beat = 0; beat < beats; beat++) {
        if (bolero && beat % 2 === 1) continue;
        const start = bar * barDuration + beat * 60 / bpm;
        const end = Math.min(duration, start + 60 / bpm * 0.72);
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(midiFrequency(rootNote + (bolero && beat === 2 ? 7 : 0)), start);
        envelope.gain.setValueAtTime(0.001, start);
        envelope.gain.linearRampToValueAtTime(0.24, start + 0.035);
        envelope.gain.exponentialRampToValueAtTime(0.001, end);
        oscillator.connect(envelope).connect(master);
        oscillator.start(start);
        oscillator.stop(end + 0.01);
      }
    }
  });
  replaceGeneratedTrack(`Pad · ${$("#musicKey").value}`, "pad", pad);
  replaceGeneratedTrack(`Bass · ${$("#musicKey").value}`, "bass", bass);
  $("#playStatus").textContent = "ĐỆM SẴN SÀNG";
  notify(bolero
    ? "Đã tạo đệm bolero tổng hợp: hợp âm móc dây và bass chậm. Đây chưa phải tiếng guitar thu thật."
    : "Đã thêm pad và bass theo vòng hợp âm.");
}

function clearSources() {
  for (const source of state.nodes) {
    try { source.stop(); } catch {}
    source.disconnect();
  }
  state.nodes.clear();
}

function updatePlayhead() {
  if (state.playing && audioContext) {
    state.playhead = playbackStartPosition + audioContext.currentTime - playbackStartedAt;
    if (state.playhead >= getProjectDuration()) {
      state.playhead = 0;
      pausePlayback();
      $("#playStatus").textContent = "HOÀN TẤT";
    }
  }
  $("#playheadLabel").textContent = formatTime(state.playhead);
  $("#durationLabel").textContent = formatTime(getProjectDuration());
  const labelWidth = $(".track-label-spacer").getBoundingClientRect().width || 132;
  $("#playhead").style.left = `${labelWidth + state.playhead * timelineScale()}px`;
}

function setPlayhead(seconds) {
  state.playhead = Math.max(0, Math.min(getProjectDuration(), seconds));
  if (state.playing) startPlaybackAt(state.playhead);
  else updatePlayhead();
}

function scheduleTrack(track, when, position) {
  if (!track.buffer || track.muted) return;
  const clipTime = position - track.start;
  const offset = Math.max(0, clipTime);
  if (offset >= track.buffer.duration) return;
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const pan = audioContext.createStereoPanner ? audioContext.createStereoPanner() : null;
  source.buffer = track.buffer;
  gain.gain.value = track.volume;
  source.connect(gain);
  if (pan) { pan.pan.value = 0; gain.connect(pan).connect(masterGain); }
  else gain.connect(masterGain);
  track.activeGain = gain;
  state.nodes.add(source);
  source.onended = () => { source.disconnect(); gain.disconnect(); if (pan) pan.disconnect(); state.nodes.delete(source); };
  const delay = Math.max(0, track.start - position);
  const startAt = audioContext.currentTime + delay;
  const duration = track.buffer.duration - offset;
  source.start(startAt, offset, duration);
}

async function startPlaybackAt(position) {
  const context = getAudioContext();
  await context.resume();
  clearSources();
  state.playhead = Math.min(Math.max(0, position), getProjectDuration());
  playbackStartPosition = state.playhead;
  playbackStartedAt = context.currentTime;
  state.playing = true;
  masterGain.gain.setTargetAtTime(state.settings.masterVolume, context.currentTime, 0.02);
  state.tracks.forEach(track => scheduleTrack(track, context.currentTime, state.playhead));
  $("#togglePlayback").textContent = "Ⅱ";
  $("#togglePlayback").setAttribute("aria-label", "Tạm dừng");
  $("#playStatus").textContent = "ĐANG PHÁT";
  if (!playTimer) playTimer = setInterval(updatePlayhead, 40);
}

function pausePlayback() {
  if (state.playing && audioContext) state.playhead = Math.min(getProjectDuration(), playbackStartPosition + audioContext.currentTime - playbackStartedAt);
  state.playing = false;
  clearSources();
  $("#togglePlayback").textContent = "▶";
  $("#togglePlayback").setAttribute("aria-label", "Phát");
  $("#playStatus").textContent = "TẠM DỪNG";
  updatePlayhead();
}

async function togglePlayback() {
  try {
    if (!state.tracks.some(track => track.buffer)) return notify("Thêm audio hoặc tạo beat trước khi phát.");
    if (state.playing) pausePlayback();
    else await startPlaybackAt(state.playhead >= getProjectDuration() ? 0 : state.playhead);
  } catch (error) {
    notify(error.message || "Không thể phát bản phối.");
  }
}

function removeTrack(id) {
  if (state.playing) pausePlayback();
  state.tracks = state.tracks.filter(track => track.id !== id);
  renderTimeline();
  updatePlayhead();
}

async function toggleRecording() {
  if (state.recording) {
    state.recorder?.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return notify("Trình duyệt không hỗ trợ thu âm. Hãy dùng Chrome hoặc Edge mới.");
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
    state.recorder = new MediaRecorder(state.micStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    state.recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    state.recorder.onstop = async () => {
      state.recording = false;
      state.micStream?.getTracks().forEach(track => track.stop());
      state.micStream = null;
      setRecordingUI(false);
      const blob = new Blob(chunks, { type: state.recorder.mimeType || "audio/webm" });
      try {
        const context = getAudioContext();
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        addTrack({ name: `Voice take ${state.tracks.filter(track => track.kind === "voice").length + 1}`, kind: "voice", buffer, fileName: "Recorded from microphone" });
        notify("Đã thêm bản thu voice vào timeline.");
      } catch (error) {
        notify(`Không thể đọc bản thu âm: ${error.message || "định dạng không hỗ trợ"}`);
      }
    };
    state.recorder.onerror = event => notify(event.error?.message || "Có lỗi khi thu âm.");
    state.recorder.start(200);
    state.recording = true;
    setRecordingUI(true);
  } catch (error) {
    notify(error.name === "NotAllowedError" ? "Bạn cần cho phép truy cập micro để thu voice." : `Không thể bật micro: ${error.message}`);
  }
}

function setRecordingUI(recording) {
  ["#recordVoice", "#recordVoiceSide"].forEach(selector => {
    const button = $(selector);
    button.classList.toggle("recording", recording);
    button.textContent = recording ? "■ Dừng thu" : (selector === "#recordVoice" ? "● Thu giọng" : "●   Bắt đầu thu");
  });
  $("#recordingStatus").textContent = recording ? "● ĐANG THU · bấm Dừng thu để kết thúc" : "Micro chưa bật";
}

function encodeWav(audioBuffer) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + frames * blockAlign);
  const view = new DataView(buffer);
  const writeString = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeString(0, "RIFF"); view.setUint32(4, 36 + frames * blockAlign, true);
  writeString(8, "WAVE"); writeString(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true); view.setUint32(28, audioBuffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  writeString(36, "data"); view.setUint32(40, frames * blockAlign, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[frame]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function exportMix() {
  const tracks = state.tracks.filter(track => track.buffer && !track.muted);
  if (!tracks.length) return notify("Không có track audio để xuất.");
  const duration = Math.max(...tracks.map(track => track.start + track.buffer.duration));
  if (duration > 600) return notify("Bản phối dài quá 10 phút; hãy rút ngắn hoặc xuất thành nhiều phần.");
  const button = $("#exportMix");
  button.disabled = true;
  button.textContent = "Đang render…";
  try {
    const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const sampleRate = 44100;
    const offline = new Context(2, Math.ceil(duration * sampleRate), sampleRate);
    const master = offline.createGain();
    master.gain.value = state.settings.masterVolume;
    master.connect(offline.destination);
    tracks.forEach(track => {
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      source.buffer = track.buffer;
      gain.gain.value = track.volume;
      source.connect(gain).connect(master);
      source.start(track.start);
    });
    const rendered = await offline.startRendering();
    const blob = encodeWav(rendered);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFilename($("#projectName").value)}.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    notify("Đã xuất bản phối WAV 16-bit.");
  } catch (error) {
    notify(`Không thể xuất bản phối: ${error.message || "lỗi render"}`);
  } finally {
    button.disabled = false;
    button.textContent = "Xuất WAV ↗";
  }
}

function downloadProject() {
  const project = {
    version: 1,
    name: $("#projectName").value,
    bpm: state.bpm,
    beatsPerBar: state.beatsPerBar,
    bars: state.bars,
    settings: state.settings,
    tracks: state.tracks.map(track => ({
      name: track.name, kind: track.kind, fileName: track.fileName,
      start: track.start, duration: track.duration, volume: track.volume,
      muted: track.muted, generated: track.generated
    }))
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(project.name)}-project.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify("Đã lưu thông số dự án. File audio cần được thêm lại khi mở.");
}

async function loadProject(file) {
  try {
    const project = JSON.parse(await file.text());
    if (!project || !Array.isArray(project.tracks)) throw new Error("File dự án không đúng định dạng.");
    if (state.playing) pausePlayback();
    state.tracks = project.tracks.map(track => ({
      ...track, id: crypto.randomUUID(), buffer: null,
      color: colors[track.kind] || colors.audio,
      muted: Boolean(track.muted)
    }));
    state.bpm = Number(project.bpm) || 96;
    state.beatsPerBar = Number(project.beatsPerBar) || 4;
    state.bars = Number(project.bars) || 8;
    state.settings = { ...state.settings, ...(project.settings || {}) };
    $("#projectName").value = project.name || "Bản nhạc mới";
    $("#tempo").value = state.bpm;
    $("#meter").value = String(state.beatsPerBar);
    $("#bars").value = String(state.bars);
    $("#beatStyle").value = state.settings.beatStyle;
    $("#beatEnergy").value = state.settings.beatEnergy;
    $("#musicKey").value = state.settings.musicKey;
    $("#chordPattern").value = state.settings.chordPattern;
    $("#beatEnergyValue").textContent = `${state.settings.beatEnergy} / 5`;
    renderTimeline();
    updatePlayhead();
    notify("Đã mở dự án. Chọn lại file audio có cùng tên để nối vào track; beat/đệm cần tạo lại.");
  } catch (error) {
    notify(error.message || "Không thể mở dự án.");
  }
}

function resetGeneratedDuration() {
  renderTimeline();
  updatePlayhead();
}

const aiFunctionUrl = "/.netlify/functions/ai-vocals";

function updateAIButton() {
  const ready = state.aiConfigured && $("#aiAccessCode").value.trim() && $("#aiConsent").checked && $("#aiLyrics").value.trim();
  $("#generateAIVocal").disabled = !ready;
  $("#generateAIVocal").classList.toggle("disabled-button", !ready);
}

async function checkAIProvider() {
  const status = $("#providerStatus");
  try {
    const response = await fetch(aiFunctionUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Máy chủ AI trả về HTTP ${response.status}.`);
    const info = await response.json();
    state.aiConfigured = Boolean(info.configured);
    status.classList.toggle("ready", state.aiConfigured);
    status.querySelector("span").textContent = state.aiConfigured ? "●" : "○";
    status.querySelector("p").textContent = state.aiConfigured
      ? "ElevenLabs + AudioShake đã sẵn sàng. Phí API áp dụng theo gói và thời lượng."
      : "Cần Netlify Functions cùng ELEVENLABS_API_KEY, AUDIOSHAKE_API_KEY và MUSIC_AI_ACCESS_CODE.";
  } catch (error) {
    state.aiConfigured = false;
    status.classList.remove("ready");
    status.querySelector("span").textContent = "○";
    status.querySelector("p").textContent = "AI chưa kết nối. Chức năng này cần chạy qua Netlify (hoặc netlify dev), không chạy trực tiếp bằng file://.";
  }
  updateAIButton();
}

async function requestAI(action, { taskId, body, contentType = "application/json" } = {}) {
  const params = new URLSearchParams({ action });
  if (taskId) params.set("taskId", taskId);
  const options = {
    method: "POST",
    headers: {
      "x-music-access-code": $("#aiAccessCode").value,
      Accept: "application/json"
    }
  };
  if (contentType === "application/json") {
    options.headers["Content-Type"] = contentType;
    options.body = JSON.stringify(body);
  } else {
    options.headers["Content-Type"] = contentType;
    options.body = body;
  }
  const response = await fetch(`${aiFunctionUrl}?${params}`, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Yêu cầu AI thất bại (HTTP ${response.status}).`);
  }
  return response;
}

async function generateAISong() {
  const button = $("#generateAIVocal");
  const lyrics = $("#aiLyrics").value.trim();
  if (!lyrics) return notify("Nhập lời bài hát trước khi tạo.");
  if (!$("#aiConsent").checked) return notify("Hãy xác nhận đồng ý gửi lời tới ElevenLabs và audio tới AudioShake trước.");
  button.disabled = true;
  button.textContent = "ElevenLabs đang tạo bài hát…";
  try {
    const generatedResponse = await requestAI("generate", {
      body: {
        lyrics,
        style: $("#aiStyle").value.trim(),
        duration: Number($("#aiDuration").value)
      }
    });
    const generatedAudio = await generatedResponse.blob();
    if (!generatedAudio.size) throw new Error("ElevenLabs không trả về file audio.");
    button.textContent = "Đang gửi bài hát tới AudioShake…";
    const separateResponse = await requestAI("separate", {
      body: generatedAudio,
      contentType: generatedAudio.type || "audio/mpeg"
    });
    const { taskId } = await separateResponse.json();
    if (!taskId) throw new Error("AudioShake không trả về mã tác vụ tách vocal.");
    button.textContent = "AudioShake đang tách track giọng…";
    let completed = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await requestAI("status", { taskId });
      const status = await statusResponse.json();
      if (status.status === "COMPLETED") { completed = true; break; }
      if (status.status === "FAILED") throw new Error("AudioShake không tách được giọng từ bài hát đã tạo.");
      button.textContent = `AudioShake đang tách giọng… (${attempt * 5}s)`;
    }
    if (!completed) throw new Error("Tách vocal quá thời gian chờ. Hãy thử lại sau.");
    button.textContent = "Đang tải vocal WAV…";
    const audioResponse = await requestAI("download", { taskId });
    const audioBuffer = await getAudioContext().decodeAudioData(await audioResponse.arrayBuffer());
    addTrack({ name: "Vocal bolero · lead", kind: "voice", buffer: audioBuffer, fileName: "bolero-vocal-lead.wav" });
    notify("Đã thêm track vocal bolero WAV riêng vào timeline. Căn chỉnh lại với beat của bạn.");
  } catch (error) {
    notify(error.message || "Không thể tạo track vocal bolero.");
  } finally {
    button.textContent = "Tạo track vocal riêng";
    updateAIButton();
  }
}

function init() {
  renderTimeline();
  updatePlayhead();
  $("#importAudio").addEventListener("click", () => $("#audioFiles").click());
  $("#importAudioSide").addEventListener("click", () => $("#audioFiles").click());
  $("#audioFiles").addEventListener("change", event => {
    importAudio(event.target.files).finally(() => { event.target.value = ""; });
  });
  $("#generateBeat").addEventListener("click", () => {
    $("#generateBeat").disabled = true;
    generateBeat().catch(error => notify(error.message || "Không thể tạo beat.")).finally(() => { $("#generateBeat").disabled = false; resetGeneratedDuration(); });
  });
  $("#generateBacking").addEventListener("click", () => {
    $("#generateBacking").disabled = true;
    generateBacking().catch(error => notify(error.message || "Không thể tạo đệm.")).finally(() => { $("#generateBacking").disabled = false; resetGeneratedDuration(); });
  });
  $("#recordVoice").addEventListener("click", toggleRecording);
  $("#recordVoiceSide").addEventListener("click", toggleRecording);
  $("#togglePlayback").addEventListener("click", togglePlayback);
  $("#stopPlayback").addEventListener("click", () => { pausePlayback(); state.playhead = 0; updatePlayhead(); });
  $("#rewind").addEventListener("click", () => setPlayhead(0));
  $("#masterVolume").addEventListener("input", event => {
    state.settings.masterVolume = Number(event.target.value) / 100;
    $("#masterVolumeLabel").textContent = `${event.target.value}%`;
    if (masterGain && audioContext) masterGain.gain.setTargetAtTime(state.settings.masterVolume, audioContext.currentTime, 0.02);
  });
  $("#tempo").addEventListener("change", event => {
    state.bpm = Math.min(200, Math.max(50, Number(event.target.value) || 96));
    event.target.value = state.bpm;
    resetGeneratedDuration();
  });
  $("#meter").addEventListener("change", event => { state.beatsPerBar = Number(event.target.value); resetGeneratedDuration(); });
  $("#bars").addEventListener("change", event => { state.bars = Number(event.target.value); resetGeneratedDuration(); });
  $("#beatStyle").addEventListener("change", event => { state.settings.beatStyle = event.target.value; });
  $("#beatEnergy").addEventListener("input", event => {
    state.settings.beatEnergy = Number(event.target.value);
    $("#beatEnergyValue").textContent = `${event.target.value} / 5`;
  });
  $("#musicKey").addEventListener("change", event => { state.settings.musicKey = event.target.value; });
  $("#chordPattern").addEventListener("change", event => { state.settings.chordPattern = event.target.value; });
  $("#saveProject").addEventListener("click", downloadProject);
  $("#openProject").addEventListener("click", () => $("#projectFile").click());
  $("#projectFile").addEventListener("change", event => {
    if (event.target.files?.[0]) loadProject(event.target.files[0]);
    event.target.value = "";
  });
  $("#exportMix").addEventListener("click", exportMix);
  ["#aiLyrics", "#aiStyle", "#aiDuration"].forEach(selector => {
    $(selector).addEventListener("input", () => {
      $("#aiConsent").checked = false;
      updateAIButton();
    });
    $(selector).addEventListener("change", () => {
      $("#aiConsent").checked = false;
      updateAIButton();
    });
  });
  $("#aiAccessCode").addEventListener("input", updateAIButton);
  $("#aiConsent").addEventListener("change", updateAIButton);
  $("#generateAIVocal").addEventListener("click", generateAISong);
  checkAIProvider();
  $("#mobileMenu").addEventListener("click", () => $(".top-actions").classList.toggle("open"));
  document.addEventListener("keydown", event => {
    if (event.target.matches("input,textarea,select,button,a")) return;
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
  });
  window.addEventListener("beforeunload", () => {
    clearInterval(playTimer);
    state.micStream?.getTracks().forEach(track => track.stop());
  });
}

init();
