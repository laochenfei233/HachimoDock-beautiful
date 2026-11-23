/*
 * [Input] 全局语音识别服务商配置（voice_chat_settings）与各适配器实现。
 * [Output] `create()`：按当前配置构造一轮识别（Box<dyn SpeechRecognizer>）。每轮语音开始时
 *          调用一次，服务商切换下一轮即生效。
 * [Pos] ASR 多服务商工厂 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::volcengine_asr::StreamingSpeechEvent;

/// 构造一轮识别。`callback` 与火山实现共享同一事件语义。
pub fn create(callback: impl Fn(StreamingSpeechEvent) + Send + Sync + 'static)
    -> Result<Box<dyn crate::speech::SpeechRecognizer>, String> {
    let config = crate::voice_chat_settings::asr_engine_config()?;
    match config.provider.as_str() {
        "volcengine" => Ok(Box::new(crate::volcengine_asr::StreamingSpeechRecognizer::start(callback)?)),
        // 通义千问二选一：qwen3-asr*（Chat Completions HTTP 一次性）或 paraformer*（WS 流式），
        // 由模型名决定——保存的模型名即协议选择。
        "dashscope" if dashscope_asr_uses_chat(&config.model) => Ok(Box::new(OneShotAsr::start(
            Transcriber::Chat(crate::mimo_tts::ChatAsrConfig {
                base_url: config.base_url, api_key: config.api_key, model: config.model,
                language: config.language, compatible_mode: true,
            }),
            callback,
        ))),
        "dashscope" => Ok(Box::new(crate::dashscope_asr::DashscopeAsr::start(
            crate::dashscope_asr::DashscopeAsrConfig {
                api_key: config.api_key, base_url: config.base_url, model: config.model,
            },
            callback,
        )?)),
        // shortcut: OpenAI 兼容转写是一次性接口，整轮只有 Final 没有部分结果；
        // 出现低延迟需求时为该类服务商补流式协议。
        "custom" => Ok(Box::new(OneShotAsr::start(
            Transcriber::OpenAi(crate::openai_audio::OpenAiAsrConfig {
                base_url: config.base_url, api_key: config.api_key, model: config.model,
                language: config.language,
            }),
            callback,
        ))),
        "mimo" => Ok(Box::new(OneShotAsr::start(
            Transcriber::Chat(crate::mimo_tts::ChatAsrConfig {
                base_url: config.base_url, api_key: config.api_key, model: config.model,
                language: config.language, compatible_mode: false,
            }),
            callback,
        ))),
        "deepseek" => Ok(Box::new(OneShotAsr::start(
            Transcriber::Deepseek(crate::deepseek_voice::DeepseekAsrConfig {
                base_url: config.base_url, api_key: config.api_key,
            }),
            callback,
        ))),
        other => Err(format!("不支持的语音识别服务商：{other}")),
    }
}

/// 一次性转写的三种请求形态：标准 multipart /audio/transcriptions、Chat Completions
/// input_audio（MiMo / 通义千问 qwen3-asr），或 DeepSeek 的 /v1/tools/asr multipart。
#[derive(Clone)]
enum Transcriber {
    OpenAi(crate::openai_audio::OpenAiAsrConfig),
    Chat(crate::mimo_tts::ChatAsrConfig),
    Deepseek(crate::deepseek_voice::DeepseekAsrConfig),
}

/// 通义千问 ASR 模型 → 协议：qwen3-asr 系走 HTTP Chat 一次性，paraformer 系走 WS 流式。
pub(crate) fn dashscope_asr_uses_chat(model: &str) -> bool {
    model.trim().to_ascii_lowercase().contains("qwen")
}

/// OpenAI 兼容 /audio/transcriptions 的一次性识别轮次：缓冲整轮 PCM，finish 时统一上传，
/// 只发 Final 事件（无 Partial）。
pub struct OneShotAsr {
    inner: Arc<Mutex<OneShotBuffer>>,
    cancelled: Arc<AtomicBool>,
    generation: u64,
}

#[derive(Default)]
struct OneShotBuffer {
    pcm: Vec<u8>,
    finished: bool,
    overflow: bool,
}

impl OneShotAsr {
    pub fn start(transcriber: Transcriber,
        callback: impl Fn(StreamingSpeechEvent) + Send + Sync + 'static) -> Self {
        let inner = Arc::new(Mutex::new(OneShotBuffer::default()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_buffer = inner.clone();
        let worker_cancelled = cancelled.clone();
        tauri::async_runtime::spawn(async move {
            let pcm = loop {
                {
                    let mut buffer = worker_buffer.lock().unwrap_or_else(|e| e.into_inner());
                    if buffer.overflow {
                        callback(StreamingSpeechEvent::Error("语音轮次超过 60 秒上限".into()));
                        return;
                    }
                    if buffer.finished {
                        break std::mem::take(&mut buffer.pcm);
                    }
                }
                if worker_cancelled.load(Ordering::SeqCst) { return; }
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            };
            if worker_cancelled.load(Ordering::SeqCst) { return; }
            callback(StreamingSpeechEvent::Ready);
            let result = match &transcriber {
                Transcriber::OpenAi(config) => crate::openai_audio::transcribe(config, &pcm).await,
                Transcriber::Chat(config) => crate::mimo_tts::transcribe(config, &pcm).await,
                Transcriber::Deepseek(config) => crate::deepseek_voice::transcribe(config, &pcm).await,
            };
            let text = match result {
                Ok(text) => text,
                Err(error) => {
                    callback(StreamingSpeechEvent::Error(error));
                    return;
                },
            };
            callback(StreamingSpeechEvent::Final { revision: 1, text, confidence: None });
        });
        Self { inner, cancelled, generation: crate::speech::next_recognizer_generation() }
    }
}

impl crate::speech::SpeechRecognizer for OneShotAsr {
    fn push_pcm(&self, pcm: &[u8]) -> Result<(), String> {
        let mut buffer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if buffer.finished { return Err("语音轮次已结束".into()); }
        if buffer.pcm.len() + pcm.len() > crate::openai_audio::MAX_TRANSCRIBE_PCM_BYTES {
            // 超限立即置位：worker 会在下一次轮询时以 Error 收尾，不再上传。
            buffer.overflow = true;
            return Err("语音轮次超过 60 秒上限".into());
        }
        buffer.pcm.extend_from_slice(pcm);
        Ok(())
    }

    fn finish(&self) -> Result<(), String> {
        let mut buffer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if buffer.finished { return Err("语音轮次已结束".into()); }
        buffer.finished = true;
        Ok(())
    }

    fn cancel(&self) { self.cancelled.store(true, Ordering::SeqCst); }

    fn generation(&self) -> u64 { self.generation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashscope_asr_protocol_follows_model_name() {
        // 二选一：qwen3-asr 系走 HTTP Chat 一次性，paraformer 系（含存量保存）走 WS 流式。
        assert!(dashscope_asr_uses_chat("qwen3-asr-flash"));
        assert!(dashscope_asr_uses_chat(" Qwen3-ASR-Flash "));
        assert!(!dashscope_asr_uses_chat("paraformer-realtime-v2"));
        assert!(!dashscope_asr_uses_chat(""));
    }
}
