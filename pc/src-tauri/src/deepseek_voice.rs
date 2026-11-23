/*
 * [Input] DeepSeek 语音工具 API（POST /v1/tools/tts、POST /v1/tools/asr）的 API Key、端点与音色。
 * [Output] TTS：整段流式 PCM（线上 24 kHz 单声道，重采样为 16 kHz 后回调）；
 *          ASR：整轮 PCM 加 WAV 头 multipart 一次性上传，返回最终文本。
 *          两个接口都没有模型参数；音色只有 stella（默认）与 tide。
 *          shortcut: ASR 是一次性接口，整轮只有 Final；需要边说边出字时换流式服务商。
 * [Pos] TTS/ASR 适配器 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// DeepSeek 只有两个固定音色；其他 id（例如形象沿用的豆包音色）回落到默认 stella。
pub fn voice_id(value: &str) -> &'static str {
    if value.trim().eq_ignore_ascii_case("tide") { "tide" } else { "stella" }
}

pub(crate) fn tts_url(base_url: &str) -> String {
    format!("{}/v1/tools/tts", base_url.trim().trim_end_matches('/'))
}

pub(crate) fn asr_url(base_url: &str) -> String {
    format!("{}/v1/tools/asr", base_url.trim().trim_end_matches('/'))
}

/// 整段合成请求体：DeepSeek 用 `voice_id` 而不是 `voice`，`pcm` 输出 24 kHz/16 位/单声道。
pub(crate) fn tts_payload(text: &str, voice: &str) -> serde_json::Value {
    serde_json::json!({
        "text": text.trim(),
        "voice_id": voice_id(voice),
        "format": "pcm",
    })
}

pub struct DeepseekTtsClient {
    pub api_key: String,
    pub base_url: String,
    pub voice: String,
}

impl DeepseekTtsClient {
    pub fn new(api_key: String, base_url: String, voice: String) -> Self {
        Self { api_key, base_url, voice }
    }

    pub fn interrupt(&mut self) {}
    pub async fn reset(&mut self) {}

    async fn synthesize_inner(&mut self, text: &str, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<usize, String> {
        let clean = text.trim();
        if clean.is_empty() { return Ok(0); }
        let url = tts_url(&self.base_url);
        let payload = tts_payload(clean, &self.voice);
        let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
        let mut response = client.post(&url)
            .bearer_auth(self.api_key.trim())
            .json(&payload)
            .send().await.map_err(|e| crate::llm_network::connection_error(&e))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = crate::openai_audio::read_limited_body(response, 512).await;
            return Err(format!("语音合成请求失败（HTTP {status}）{detail}"));
        }
        // 24 kHz/16 位/单声道原始 PCM 随响应流式返回，以连接 EOF 为结束；中途断开视为失败。
        let mut emitted = 0usize;
        let mut resampler = crate::openai_audio::ResampleState::default();
        while let Some(chunk) = response.chunk().await.map_err(|_| "语音合成响应中断")? {
            crate::openai_audio::resample_24k_to_16k(&chunk, &mut resampler, &mut |pcm| {
                emitted += pcm.len();
                on_pcm(pcm);
            });
        }
        if emitted == 0 { return Err("语音合成未返回任何音频".into()); }
        Ok(emitted)
    }
}

impl crate::speech::TtsEngine for DeepseekTtsClient {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: crate::speech::PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        Box::pin(async move { DeepseekTtsClient::synthesize_inner(self, text, on_pcm).await })
    }
    fn interrupt(&mut self) { DeepseekTtsClient::interrupt(self); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { DeepseekTtsClient::reset(self).await })
    }
}

#[derive(Clone)]
pub struct DeepseekAsrConfig {
    pub base_url: String,
    pub api_key: String,
}

/// 整轮 PCM（16 kHz 单声道 S16LE）加 WAV 头一次性识别；请求体没有模型/语种字段。
pub async fn transcribe(cfg: &DeepseekAsrConfig, pcm_16k: &[u8]) -> Result<String, String> {
    if pcm_16k.is_empty() { return Ok(String::new()); }
    let url = asr_url(&cfg.base_url);
    crate::openai_audio::upload_transcription(&url, &cfg.api_key, &[], pcm_16k).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tide_is_preserved_and_other_speakers_fall_back_to_stella() {
        assert_eq!(voice_id("tide"), "tide");
        assert_eq!(voice_id(" Tide "), "tide");
        assert_eq!(voice_id("stella"), "stella");
        assert_eq!(voice_id("zh_female_peiqi_uranus_bigtts"), "stella");
        assert_eq!(voice_id(""), "stella");
    }

    #[test]
    fn tool_endpoints_join_the_preset_host_without_duplicating_slashes() {
        assert_eq!(tts_url("https://api.deepseek.com"), "https://api.deepseek.com/v1/tools/tts");
        assert_eq!(asr_url(" https://api.deepseek.com/ "), "https://api.deepseek.com/v1/tools/asr");
    }

    #[test]
    fn tts_payload_matches_the_tools_api_and_falls_back_to_stella() {
        let payload = tts_payload(" 你好 ", "zh_female_peiqi_uranus_bigtts");
        assert_eq!(payload["text"], "你好");
        assert_eq!(payload["voice_id"], "stella");
        assert_eq!(payload["format"], "pcm");
        assert_eq!(tts_payload("hi", "tide")["voice_id"], "tide");
    }
}
