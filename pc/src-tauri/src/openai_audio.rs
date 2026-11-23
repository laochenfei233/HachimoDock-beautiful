/*
 * [Input] OpenAI 兼容音频端点（POST /audio/speech、POST /audio/transcriptions）的
 *         baseUrl/Key/模型/音色配置；通用自定义语音服务商与小米 MiMo 预设都经此适配器。
 * [Output] TTS：PCM 流式回调（假设线端 24 kHz，重采样为 16 kHz 单声道 S16LE）；
 *          ASR：整轮 PCM 加 WAV 头一次性 multipart 上传，只返回最终文本。
 *          shortcut: 假设 /audio/speech 的 pcm 响应固定 24 kHz（OpenAI 规范），非 24 kHz
 *          的兼容服务商会音调偏移；出现这类服务商时把采样率放进服务商配置。
 * [Pos] TTS/ASR 适配器 in pc/src-tauri/src。
 * [Sync] 更新此 header 与 `pc/src-tauri/src/.folder.md`（若存在）。
 */

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// 一次性转写的 PCM 上限（60 s × 16 kHz × 2 字节），约为豆包 30 s 上限的两倍。
pub const MAX_TRANSCRIBE_PCM_BYTES: usize = 16_000 * 2 * 60;

/// OpenAI 兼容端点地址（供 /audio/speech 与 /audio/transcriptions 复用同一拼接规则）。
pub fn speech_url(base_url: &str) -> String {
    format!("{}/audio/speech", base_url.trim().trim_end_matches('/'))
}

pub fn transcriptions_url(base_url: &str) -> String {
    format!("{}/audio/transcriptions", base_url.trim().trim_end_matches('/'))
}

/// /audio/speech 请求体形状：model/input/speed/response_format 固定，
/// voice 仅在非空时携带（部分兼容端点不接受空音色字段）。
pub fn speech_payload(model: &str, input: &str, voice: &str, speed: f32) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model.trim(), "input": input.trim(), "speed": speed, "response_format": "pcm",
    });
    if !voice.trim().is_empty() { payload["voice"] = serde_json::Value::String(voice.trim().to_string()); }
    payload
}

// ---- TTS ---------------------------------------------------------------------------------------

/// OpenAI 兼容 /audio/speech 合成客户端。单次请求、绝不自动重试（设备端已开始播放，
/// 重试会重复语音），与豆包实现的 retry_safe 语义一致。
pub struct OpenAiTtsClient {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub voice: String,
    pub speed: f32,
}

impl OpenAiTtsClient {
    pub fn new(base_url: String, api_key: String, model: String, voice: String, speed: f32) -> Self {
        Self { base_url, api_key, model, voice, speed: if speed.is_finite() && speed > 0.0 { speed } else { 1.0 } }
    }

    pub fn interrupt(&mut self) {}
    pub async fn reset(&mut self) {}

    async fn synthesize_inner(&mut self, text: &str, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<usize, String> {
        let clean = text.trim();
        if clean.is_empty() { return Ok(0); }
        let url = speech_url(&self.base_url);
        let payload = speech_payload(&self.model, clean, &self.voice, self.speed);
        let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
        let mut response = client.post(&url).bearer_auth(self.api_key.trim()).json(&payload).send().await
            .map_err(|e| crate::llm_network::connection_error(&e))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = read_limited_body(response, 512).await;
            return Err(format!("语音合成请求失败（HTTP {status}）{detail}"));
        }
        let mut emitted = 0usize;
        let mut resampler = ResampleState::default();
        while let Some(chunk) = response.chunk().await.map_err(|_| "语音合成响应中断")? {
            resample_24k_to_16k(&chunk, &mut resampler, &mut |pcm| {
                emitted += pcm.len();
                on_pcm(pcm);
            });
        }
        Ok(emitted)
    }
}

impl crate::speech::TtsEngine for OpenAiTtsClient {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: crate::speech::PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        Box::pin(async move { OpenAiTtsClient::synthesize_inner(self, text, on_pcm).await })
    }
    fn interrupt(&mut self) { OpenAiTtsClient::interrupt(self); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { OpenAiTtsClient::reset(self).await })
    }
}

// ---- 重采样 --------------------------------------------------------------------------------------

/// 线性插值重采样状态机（默认 24 kHz→16 kHz，step 可指定源采样率比例）。
/// 输出时间 t=k·step 落在样本区间 [⌊t⌋, ⌊t⌋+1)，对 s⌊t⌋ 与 s⌊t⌋+1 插值；绝对时间
/// 跨 chunk 连续，流式分片不影响输出。shortcut: step≤1（升采样/同采样率）按直通处理，
/// 仅降采样做插值；流式输入的末尾可能少 1 个输出样本（≈60 µs，不可闻）。
pub struct ResampleState {
    prev: Option<f32>,
    /// 下一个输出样本的绝对输入时间（单位：输入样本）。
    t: f64,
    count: u64,
    /// 每个输出样本步进的输入样本数（24 kHz→16 kHz 为 1.5）。
    step: f64,
}

impl Default for ResampleState {
    fn default() -> Self {
        Self { prev: None, t: 0.0, count: 0, step: 1.5 }
    }
}

impl ResampleState {
    pub fn with_step(step: f64) -> Self {
        Self { prev: None, t: 0.0, count: 0, step: if step > 0.0 { step } else { 1.0 } }
    }
}

pub fn resample_24k_to_16k(input: &[u8], state: &mut ResampleState, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) {
    let mut out: Vec<u8> = Vec::with_capacity((input.len() as f64 / state.step) as usize * 2 + 4);
    for pair in input.chunks_exact(2) {
        let cur = i16::from_le_bytes([pair[0], pair[1]]) as f32;
        if state.step <= 1.0 {
            out.extend_from_slice(pair);
            state.t += state.step;
            state.count += 1;
            state.prev = Some(cur);
            continue;
        }
        let prev = state.prev.unwrap_or(cur);
        let base = state.count as f64 - 1.0;
        while state.t < state.count as f64 {
            let sample = prev + (cur - prev) * (state.t - base) as f32;
            out.extend_from_slice(&(sample.clamp(-32768.0, 32767.0) as i16).to_le_bytes());
            state.t += state.step;
        }
        state.prev = Some(cur);
        state.count += 1;
    }
    if !out.is_empty() { on_pcm(&out); }
}

/// 单样本入口（供 WAV 整段解码按源采样率喂入，如 MiMo 的 WAV 响应）。
pub fn resample_mono_16k(sample_le_bytes: &[u8], state: &mut ResampleState, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) {
    let cur = i16::from_le_bytes([sample_le_bytes[0], sample_le_bytes[1]]) as f32;
    if state.step <= 1.0 {
        // 同采样率/升采样：直通本样本（否则插值会把序列延迟一个样本）。
        on_pcm(sample_le_bytes);
        state.t += state.step;
        state.count += 1;
        state.prev = Some(cur);
        return;
    }
    let prev = state.prev.unwrap_or(cur);
    let base = state.count as f64 - 1.0; // 本样本的绝对位置 = count；插值区间为 [count-1, count)
    let mut out: Vec<u8> = Vec::new();
    while state.t < state.count as f64 {
        let sample = prev + (cur - prev) * (state.t - base) as f32;
        out.extend_from_slice(&(sample.clamp(-32768.0, 32767.0) as i16).to_le_bytes());
        state.t += state.step;
    }
    state.prev = Some(cur);
    state.count += 1;
    if !out.is_empty() { on_pcm(&out); }
}

// ---- ASR（一次性转写） ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct OpenAiAsrConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub language: Option<String>,
}

/// 整轮 PCM（16 kHz 单声道 S16LE）加 WAV 头后一次性转写；只有最终文本，没有部分结果。
pub async fn transcribe(cfg: &OpenAiAsrConfig, pcm_16k: &[u8]) -> Result<String, String> {
    if pcm_16k.is_empty() { return Ok(String::new()); }
    let mut fields: Vec<(String, String)> = vec![
        ("model".into(), cfg.model.trim().to_string()),
        ("response_format".into(), "json".into()),
    ];
    if let Some(language) = cfg.language.as_deref().filter(|l| !l.trim().is_empty()) {
        fields.push(("language".into(), language.trim().to_string()));
    }
    upload_transcription(&transcriptions_url(&cfg.base_url), &cfg.api_key, &fields, pcm_16k).await
}

/// multipart 上传整轮音频并解析 `{"text": ...}`；DeepSeek ASR 等无模型/语种字段的端点传空 fields。
pub(crate) async fn upload_transcription(url: &str, api_key: &str, fields: &[(String, String)], pcm_16k: &[u8])
    -> Result<String, String> {
    let pcm = if pcm_16k.len() > MAX_TRANSCRIBE_PCM_BYTES {
        &pcm_16k[..MAX_TRANSCRIBE_PCM_BYTES]
    } else {
        pcm_16k
    };
    let (boundary, body) = multipart_body(fields, "audio.wav", "audio/wav", &wav_wrap(pcm));
    let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
    let response = client.post(url)
        .bearer_auth(api_key.trim())
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send().await.map_err(|e| crate::llm_network::connection_error(&e))?;
    let status = response.status();
    let raw = read_limited_body_from(response, 64 * 1024).await;
    if !status.is_success() {
        return Err(format!("语音识别请求失败（HTTP {}）{}", status.as_u16(), raw.replace('\n', " ")));
    }
    let value: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|_| "语音识别响应格式不正确")?;
    value["text"].as_str().map(str::trim).map(str::to_owned)
        .ok_or_else(|| "语音识别响应缺少文本".to_string())
}

/// 最小 WAV 容器（44 字节头 + PCM），16 kHz 单声道 16 位。
pub fn wav_wrap(pcm: &[u8]) -> Vec<u8> {
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    let push_u32 = |wav: &mut Vec<u8>, v: u32| wav.extend_from_slice(&v.to_le_bytes());
    wav.extend_from_slice(b"RIFF");
    push_u32(&mut wav, (36 + pcm.len()) as u32);
    wav.extend_from_slice(b"WAVEfmt ");
    push_u32(&mut wav, 16); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    push_u32(&mut wav, 16_000); // sample rate
    push_u32(&mut wav, 16_000 * 2); // byte rate
    wav.extend_from_slice(&1u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    push_u32(&mut wav, pcm.len() as u32);
    wav.extend_from_slice(pcm);
    wav
}

/// reqwest 未启用 multipart feature；手工拼装最小 multipart 表单（仅文本字段 + 单文件部分）。
fn multipart_body(fields: &[(String, String)], filename: &str, mime: &str, file: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("hachimo-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(file);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

pub(crate) async fn read_limited_body(response: reqwest::Response, limit: usize) -> String {
    read_limited_body_from(response, limit).await.replace('\n', " ")
}

async fn read_limited_body_from(mut response: reqwest::Response, limit: usize) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= limit { break; }
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_keeps_dc_signal_and_shrinks_length_by_two_thirds() {
        // 恒定信号必须原样通过（首个输出样本不得用 0 当作前值）。
        let constant: Vec<u8> = (0..1200).flat_map(|_| 1000i16.to_le_bytes()).collect();
        let mut state = ResampleState::default();
        let mut out = Vec::new();
        resample_24k_to_16k(&constant, &mut state, &mut |pcm| out.extend_from_slice(pcm));
        assert_eq!(out.len(), 1600); // 1200 个输入样本 → 800 个输出样本
        for pair in out.chunks_exact(2) {
            assert_eq!(i16::from_le_bytes([pair[0], pair[1]]), 1000);
        }
        // 跨 chunk 绝对时间连续：3 个单样本分片 → 2 个输出样本。
        let mut state = ResampleState::default();
        let mut total = 0usize;
        for _ in 0..3 {
            resample_24k_to_16k(&[0, 0], &mut state, &mut |pcm| total += pcm.len() / 2);
        }
        assert_eq!(total, 2);
    }

    #[test]
    fn wav_header_matches_16k_mono_16bit_and_multipart_layout() {
        let wav = wav_wrap(&[1, 2, 3, 4]);
        assert_eq!(wav.len(), 48);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
        let (boundary, body) = multipart_body(&[("model".into(), "m".into())], "audio.wav", "audio/wav", &[7, 8]);
        let text = String::from_utf8_lossy(&body[..body.len() - 12]).to_string();
        assert!(text.contains("name=\"model\"\r\n\r\nm\r\n"));
        assert!(text.contains("filename=\"audio.wav\"") && text.contains("audio/wav"));
        // 文件部分是二进制：原始字节在前，终止边界收尾。
        let suffix = format!("\r\n--{boundary}--\r\n");
        assert!(body.ends_with(suffix.as_bytes()));
        assert!(body[..body.len() - suffix.len()].ends_with(&[7, 8]));
    }

    #[test]
    fn openai_audio_request_urls_and_body_shape() {
        assert_eq!(speech_url("https://api.xiaomimimo.com/v1/"), "https://api.xiaomimimo.com/v1/audio/speech");
        assert_eq!(transcriptions_url(" https://relay.invalid/v1 "), "https://relay.invalid/v1/audio/transcriptions");
        let with_voice = speech_payload("mimo-v2.5-tts", " 你好 ", "mimo_default", 1.05);
        assert_eq!(with_voice["model"], "mimo-v2.5-tts");
        assert_eq!(with_voice["input"], "你好");
        assert_eq!(with_voice["voice"], "mimo_default");
        assert!((with_voice["speed"].as_f64().unwrap() - 1.05).abs() < 1e-6);
        assert_eq!(with_voice["response_format"], "pcm");
        let without_voice = speech_payload("m", "hi", "  ", 1.0);
        assert!(without_voice.get("voice").is_none());
    }
}
