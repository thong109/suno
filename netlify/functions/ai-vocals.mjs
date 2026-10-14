import { timingSafeEqual } from "node:crypto";

const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192";
const AUDIOSHAKE_URL = "https://api.audioshake.ai";
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const AUDIO_LIMIT = 50 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function isAuthorized(request) {
  const expected = process.env.MUSIC_AI_ACCESS_CODE;
  const provided = request.headers.get("x-music-access-code");
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function serviceError(service, error) {
  console.error(`${service} request failed:`, error);
  return json({
    error: error.name === "AbortError"
      ? `${service} phản hồi quá lâu.`
      : `Không thể kết nối tới ${service}.`
  }, 502);
}

function taskUrl(taskId) {
  if (!TASK_ID_PATTERN.test(String(taskId || ""))) throw new Error("Mã tác vụ không hợp lệ.");
  return `${AUDIOSHAKE_URL}/tasks/${encodeURIComponent(taskId)}`;
}

export default async function handler(request) {
  const action = new URL(request.url).searchParams.get("action");
  const elevenLabsReady = Boolean(process.env.ELEVENLABS_API_KEY);
  const audioShakeReady = Boolean(process.env.AUDIOSHAKE_API_KEY);
  if (request.method === "GET") {
    return json({
      configured: elevenLabsReady && audioShakeReady && Boolean(process.env.MUSIC_AI_ACCESS_CODE),
      providers: { songGeneration: elevenLabsReady, vocalSeparation: audioShakeReady }
    });
  }
  if (request.method !== "POST") return json({ error: "Phương thức không được hỗ trợ." }, 405);
  if (!process.env.MUSIC_AI_ACCESS_CODE) return json({ error: "AI chưa được cấu hình trên máy chủ." }, 503);
  if (!isAuthorized(request)) return json({ error: "Mã truy cập AI không đúng." }, 401);
  if (action === "generate" && !elevenLabsReady) return json({ error: "Chưa cấu hình ELEVENLABS_API_KEY trên máy chủ." }, 503);
  if (["separate", "status", "download"].includes(action) && !audioShakeReady) {
    return json({ error: "Chưa cấu hình AUDIOSHAKE_API_KEY trên máy chủ." }, 503);
  }

  if (action === "generate") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Dữ liệu gửi lên không hợp lệ." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Dữ liệu gửi lên không hợp lệ." }, 400);
    }
    const lyrics = typeof body.lyrics === "string" ? body.lyrics.trim() : "";
    const lines = lyrics.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const style = typeof body.style === "string" ? body.style.trim() : "";
    const duration = Number(body.duration);
    if (!lyrics || lyrics.length > 6000 || lines.length > 30 || lines.some(line => line.length > 200)) {
      return json({ error: "Lời cần có tối đa 30 dòng, mỗi dòng không quá 200 ký tự (tổng tối đa 6000)." }, 400);
    }
    if (style.length > 500) return json({ error: "Phong cách âm nhạc tối đa 500 ký tự." }, 400);
    if (![30, 60, 90].includes(duration)) return json({ error: "Thời lượng được hỗ trợ là 30, 60 hoặc 90 giây." }, 400);

    const plan = {
      chunks: [{
        text: `[Verse]\n${lines.join("\n")}`,
        duration_ms: duration * 1000,
        positive_styles: [
          "Vietnamese bolero",
          "slow 4/4 bolero rhythm",
          "solo expressive lead singing voice",
          "warm nostalgic romantic delivery",
          "clear Vietnamese pronunciation",
          "nylon-string guitar and gentle traditional bolero accompaniment",
          "sing the provided Vietnamese lyrics"
        ].concat(style ? [style] : []),
        negative_styles: ["instrumental only", "rap", "electronic dance music"],
        context_adherence: "high"
      }]
    };

    try {
      const response = await fetchWithTimeout(ELEVENLABS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({ model_id: "music_v2_5", composition_plan: plan })
      });
      if (!response.ok) {
        console.error("ElevenLabs rejected vocal generation:", response.status);
        return json({ error: "ElevenLabs không tạo được bài hát. Kiểm tra gói API, hạn mức và lời nhập." }, 502);
      }
      const audio = await response.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > AUDIO_LIMIT) {
        return json({ error: "File bài hát tạo ra rỗng hoặc vượt quá giới hạn 50 MB." }, 502);
      }
      return new Response(audio, {
        headers: {
          "Content-Type": response.headers.get("Content-Type")?.startsWith("audio/")
            ? response.headers.get("Content-Type")
            : "audio/mpeg",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return serviceError("ElevenLabs", error);
    }
  }

  if (action === "separate") {
    const mimeType = request.headers.get("content-type") || "";
    if (!mimeType.startsWith("audio/")) return json({ error: "Không nhận được audio để tách vocal." }, 400);
    try {
      const audio = await request.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > AUDIO_LIMIT) {
        return json({ error: "Audio cần lớn hơn 0 byte và không vượt quá 50 MB." }, 413);
      }
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mimeType }), "bolero-source.mp3");
      const upload = await fetchWithTimeout(`${AUDIOSHAKE_URL}/assets`, {
        method: "POST",
        headers: { "x-api-key": process.env.AUDIOSHAKE_API_KEY },
        body: form
      });
      if (!upload.ok) {
        console.error("AudioShake asset upload failed:", upload.status);
        return json({ error: "AudioShake không nhận được audio để tách vocal." }, 502);
      }
      const asset = await upload.json();
      if (!asset.id) return json({ error: "AudioShake không trả về mã file audio." }, 502);

      const task = await fetchWithTimeout(`${AUDIOSHAKE_URL}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.AUDIOSHAKE_API_KEY
        },
        body: JSON.stringify({
          assetId: asset.id,
          targets: [{ model: "vocals_lead", formats: ["wav"] }]
        })
      });
      if (!task.ok) {
        console.error("AudioShake vocal separation submission failed:", task.status);
        return json({ error: "AudioShake không thể bắt đầu tách track giọng." }, 502);
      }
      const taskData = await task.json();
      if (!taskData.id) return json({ error: "AudioShake không trả về mã tác vụ tách vocal." }, 502);
      return json({ taskId: taskData.id });
    } catch (error) {
      return serviceError("AudioShake", error);
    }
  }

  if (action === "status" || action === "download") {
    let url;
    try {
      url = taskUrl(new URL(request.url).searchParams.get("taskId"));
    } catch {
      return json({ error: "Mã tác vụ không hợp lệ." }, 400);
    }
    try {
      const response = await fetchWithTimeout(url, {
        headers: { "x-api-key": process.env.AUDIOSHAKE_API_KEY }
      });
      if (!response.ok) return json({ error: "Không thể kiểm tra trạng thái với AudioShake." }, 502);
      const task = await response.json();
      const target = task.targets?.find(item => item.model === "vocals_lead");
      if (!target) return json({ error: "Tác vụ không có track giọng chính." }, 502);

      if (action === "status") {
        if (target.status === "error") {
          console.error("AudioShake vocal separation error:", target.error);
          return json({ status: "FAILED" });
        }
        return json({ status: target.status === "completed" ? "COMPLETED" : "PROCESSING" });
      }
      if (target.status !== "completed") return json({ error: "Track giọng chưa sẵn sàng để tải." }, 409);
      const output = target.output?.find(item => item.format === "wav") || target.output?.[0];
      if (!output?.link) return json({ error: "AudioShake không trả về file vocal." }, 502);
      const fileUrl = new URL(output.link);
      if (fileUrl.protocol !== "https:" || fileUrl.hostname !== "cdn.audioshake.ai") {
        return json({ error: "Địa chỉ file vocal từ AudioShake không hợp lệ." }, 502);
      }
      const file = await fetchWithTimeout(fileUrl);
      if (!file.ok) return json({ error: "Không thể tải track vocal từ AudioShake." }, 502);
      const audio = await file.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > AUDIO_LIMIT) return json({ error: "File vocal vượt quá giới hạn 50 MB." }, 413);
      return new Response(audio, {
        headers: {
          "Content-Type": file.headers.get("Content-Type")?.startsWith("audio/")
            ? file.headers.get("Content-Type")
            : "audio/wav",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return serviceError("AudioShake", error);
    }
  }

  return json({ error: "Thao tác AI không hợp lệ." }, 400);
}
