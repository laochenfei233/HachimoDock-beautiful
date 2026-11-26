/*
 * [Input] 具体语音实现（豆包 DoubaoTtsClient / StreamingSpeechRecognizer、DashScope、
 *         OpenAI 兼容适配器）与所有与厂商无关的调用方（realtime chat、组件语音、语音笔记等）。
 * [Output] TtsEngine / SpeechRecognizer trait（16 kHz 单声道 S16LE PCM 为统一交换格式）与适配 impl；
 *          多服务商工厂在 voice_chat_settings（TTS）与 asr_engine（ASR）。
 * [Pos] 中立的语音引擎抽象层 in pc/src-tauri/src。
 * [Sync] 接口变化时更新 `pc/docs/realtime-chat.md`。
 */

use std::future::Future;
use std::pin::Pin;

pub use crate::volcengine_asr::StreamingSpeechEvent;

pub type PcmSink<'a> = &'a mut (dyn FnMut(&[u8]) + Send);

/// 一个可合成的语音会话。PCM 一律 16 kHz 单声道 S16LE——各适配器负责把自己服务商的
/// 线上格式转码成该格式。
pub trait TtsEngine: Send {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>>;
    /// 立即停掉进行中的句子（打断/barge-in）。
    fn interrupt(&mut self);
    /// 丢弃缓存的连接/会话（换形象或换服务商时）。
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

impl TtsEngine for crate::doubao_tts::DoubaoTtsClient {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        Box::pin(async move {
            crate::doubao_tts::DoubaoTtsClient::synthesize(self, text, |pcm| on_pcm(pcm)).await
        })
    }
    fn interrupt(&mut self) { crate::doubao_tts::DoubaoTtsClient::interrupt(self); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { crate::doubao_tts::DoubaoTtsClient::reset(self).await })
    }
}

/// 让 `&mut Box<dyn TtsEngine>` 可以直接作为 `&mut dyn TtsEngine` 传参（unsize 转发）。
impl<T: TtsEngine + ?Sized> TtsEngine for Box<T> {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        (**self).synthesize(text, on_pcm)
    }
    fn interrupt(&mut self) { (**self).interrupt(); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> { (**self).reset() }
}

/// 一轮流式识别轮次（设备 PCM 进 → 转写事件出）。事件与豆包实现共用一套枚举。
pub trait SpeechRecognizer: Send {
    fn push_pcm(&self, pcm: &[u8]) -> Result<(), String>;
    fn finish(&self) -> Result<(), String>;
    fn cancel(&self);
    /// 轮次代际：同一会话内单调递增，调用方据此丢弃上一个轮次的迟到事件。
    fn generation(&self) -> u64;
    /// 本轮收尾等待预算：一次性识别服务商在 finish 后即进入终态，预算只需覆盖网络超时。
    fn final_wait_budget(&self) -> std::time::Duration { std::time::Duration::from_secs(20) }
}

/// 非火山服务商的轮次代际：进程级自增即可满足"新轮次 > 旧轮次"的判定。
pub fn next_recognizer_generation() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

impl SpeechRecognizer for crate::volcengine_asr::StreamingSpeechRecognizer {
    fn push_pcm(&self, pcm: &[u8]) -> Result<(), String> {
        crate::volcengine_asr::StreamingSpeechRecognizer::push_pcm(self, pcm)
    }
    fn finish(&self) -> Result<(), String> {
        crate::volcengine_asr::StreamingSpeechRecognizer::finish(self)
    }
    fn cancel(&self) { crate::volcengine_asr::StreamingSpeechRecognizer::cancel(self) }
    fn generation(&self) -> u64 { crate::volcengine_asr::StreamingSpeechRecognizer::generation(self) }
    fn final_wait_budget(&self) -> std::time::Duration { crate::volcengine_asr::StreamingSpeechRecognizer::final_wait_budget(self) }
}
