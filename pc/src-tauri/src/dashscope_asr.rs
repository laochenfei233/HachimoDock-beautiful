/*
 * [Input] 通义千问（阿里云百炼）实时语音识别的 API Key、模型（paraformer-realtime-v2 等预设）
 *         与端点（settings.asr_base_url）。
 * [Output] DashScope WebSocket 推理协议的流式识别轮次：run-task → 二进制 PCM 帧 → finish-task，
 *          事件以 StreamingSpeechEvent（Ready/Partial/Final/Error）回调；输入 16 kHz 单声道
 *          S16LE PCM；一轮只产一个 Final（多句时拼接），与火山实现的单轮语义一致。
 * [Pos] ASR 适配器 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::volcengine_asr::StreamingSpeechEvent;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
/// 单轮音频上限：30 s × 16 kHz × 2 字节，与火山实现一致。
const MAX_ROUND_PCM_BYTES: usize = 16_000 * 2 * 30;

#[derive(Debug)]
enum AsrCommand {
    Pcm(Vec<u8>),
    Finish,
}

pub struct DashscopeAsrConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// 预设端点（https://dashscope.aliyuncs.com）映射到推理 WS 地址；已是 wss:// 的自定义端点原样续接。
pub fn inference_ws_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let host = base
        .strip_prefix("https://")
        .or_else(|| base.strip_prefix("http://"))
        .or_else(|| base.strip_prefix("wss://"))
        .unwrap_or(base);
    format!("wss://{host}/api-ws/v1/inference")
}

/// 一轮一次性的流式识别。与火山 StreamingSpeechRecognizer 生命周期一致：
/// start → push_pcm* → finish/cancel；Drop 即取消。
pub struct DashscopeAsr {
    sender: mpsc::UnboundedSender<AsrCommand>,
    cancelled: Arc<AtomicBool>,
    generation: u64,
}

impl DashscopeAsr {
    pub fn start(
        config: DashscopeAsrConfig,
        callback: impl Fn(StreamingSpeechEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        if config.api_key.trim().is_empty() {
            return Err("请先在 API 配置保存通义千问语音识别的 API Key".into());
        }
        if config.model.trim().is_empty() {
            return Err("请在 API 配置填写通义千问语音识别模型".into());
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let callback = Arc::new(callback);
        let worker_callback = callback.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_round(config, receiver, &*worker_callback, &worker_cancelled).await {
                worker_callback(StreamingSpeechEvent::Error(error));
            }
        });
        Ok(Self { sender, cancelled, generation: crate::speech::next_recognizer_generation() })
    }

    pub fn push_pcm(&self, pcm: &[u8]) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) { return Err("语音识别已取消".into()); }
        self.sender.send(AsrCommand::Pcm(pcm.to_vec())).map_err(|_| "语音识别会话已结束".to_string())
    }

    pub fn finish(&self) -> Result<(), String> {
        self.sender.send(AsrCommand::Finish).map_err(|_| "语音识别会话已结束".to_string())
    }

    pub fn cancel(&self) { self.cancelled.store(true, Ordering::SeqCst); }
}

impl Drop for DashscopeAsr {
    fn drop(&mut self) { self.cancel(); }
}

impl crate::speech::SpeechRecognizer for DashscopeAsr {
    fn push_pcm(&self, pcm: &[u8]) -> Result<(), String> { DashscopeAsr::push_pcm(self, pcm) }
    fn finish(&self) -> Result<(), String> { DashscopeAsr::finish(self) }
    fn cancel(&self) { DashscopeAsr::cancel(self) }
    fn generation(&self) -> u64 { self.generation }
}

async fn run_round(
    config: DashscopeAsrConfig,
    mut receiver: mpsc::UnboundedReceiver<AsrCommand>,
    callback: &(dyn Fn(StreamingSpeechEvent) + Send + Sync),
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut request = inference_ws_url(&config.base_url)
        .into_client_request()
        .map_err(|error| format!("通义千问语音识别地址无效: {error}"))?;
    let auth = format!("Bearer {}", config.api_key.trim());
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&auth).map_err(|_| "API Key 含非法字符")?);
    request.headers_mut().insert("user-agent", HeaderValue::from_static("HachimoDock"));

    let (mut socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, crate::llm_network::connect_websocket("dashscope-asr", request))
        .await
        .map_err(|_| "连接通义千问语音识别超时".to_string())?
        .map_err(|error| format!("连接通义千问语音识别失败: {error}"))?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let run_task = serde_json::json!({
        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {
            "task_group": "audio", "task": "asr", "function": "recognition",
            "model": config.model.trim(),
            "parameters": {"format": "pcm", "sample_rate": 16_000},
            "input": {},
        },
    });
    send_text(&mut socket, &run_task, "run-task").await?;

    // 等待 task-started 后才能发音频。
    loop {
        let message = next_text(&mut socket, "等待识别任务启动").await?;
        let Some(event) = parse_event(&message) else { continue };
        match event.name.as_str() {
            "task-started" => break,
            "task-failed" => return Err(event.error.unwrap_or_else(|| "识别任务启动失败".into())),
            _ => {},
        }
    }
    callback(StreamingSpeechEvent::Ready);

    let mut completed = String::new();
    let mut running = String::new();
    let mut revision = 0u64;
    let mut finish_requested = false;
    let mut sent_bytes = 0usize;
    let mut final_sent = false;

    loop {
        tokio::select! {
            biased;
            _ = poll_cancelled(cancelled) => return Ok(()),
            command = receiver.recv(), if !finish_requested => {
                match command {
                    Some(AsrCommand::Pcm(pcm)) => {
                        sent_bytes += pcm.len();
                        if sent_bytes > MAX_ROUND_PCM_BYTES {
                            return Err("语音轮次超过 30 秒上限".into());
                        }
                        send_binary(&mut socket, &pcm).await?;
                    },
                    Some(AsrCommand::Finish) | None => {
                        finish_requested = true;
                        let finish_task = serde_json::json!({
                            "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
                            "payload": {"input": {}},
                        });
                        send_text(&mut socket, &finish_task, "finish-task").await?;
                    },
                }
            },
            message = socket.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("通义千问语音识别连接中断: {error}"))?;
                let Message::Text(text) = message else { continue };
                let Some(event) = parse_event(&text) else { continue };
                match event.name.as_str() {
                    "result-generated" => {
                        if event.heartbeat == Some(true) { continue; }
                        let sentence_text = event.text.unwrap_or_default();
                        if event.sentence_end == Some(true) {
                            if !completed.ends_with(' ') && !completed.is_empty() && !sentence_text.is_empty() { completed.push(' '); }
                            completed.push_str(&sentence_text);
                            running.clear();
                        } else {
                            running = sentence_text;
                        }
                        revision += 1;
                        callback(StreamingSpeechEvent::Partial {
                            revision, text: merge_text(&completed, &running), confidence: None,
                        });
                    },
                    "task-finished" => {
                        revision += 1;
                        final_sent = true;
                        callback(StreamingSpeechEvent::Final {
                            revision, text: merge_text(&completed, &running), confidence: None,
                        });
                        break;
                    },
                    "task-failed" => return Err(event.error.unwrap_or_else(|| "识别任务失败".into())),
                    _ => {},
                }
            },
        }
    }
    if !final_sent {
        // 连接在 finish 后被服务端直接关闭：以已收文本作为最终结果，避免整轮丢弃。
        revision += 1;
        callback(StreamingSpeechEvent::Final { revision, text: merge_text(&completed, &running), confidence: None });
    }
    Ok(())
}

fn merge_text(completed: &str, running: &str) -> String {
    format!("{completed}{running}").trim().to_string()
}

async fn poll_cancelled(cancelled: &AtomicBool) {
    loop {
        if cancelled.load(Ordering::SeqCst) { return; }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

async fn send_text(socket: &mut WsSocket, value: &serde_json::Value, phase: &str) -> Result<(), String> {
    let message = Message::Text(serde_json::to_string(value).unwrap_or_default().into());
    tokio::time::timeout(STEP_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| format!("发送 {phase} 超时"))?
        .map_err(|error| format!("发送 {phase} 失败: {error}"))
}

async fn send_binary(socket: &mut WsSocket, pcm: &[u8]) -> Result<(), String> {
    tokio::time::timeout(STEP_TIMEOUT, socket.send(Message::Binary(pcm.to_vec().into())))
        .await
        .map_err(|_| "发送音频帧超时".to_string())?
        .map_err(|error| format!("发送音频帧失败: {error}"))
}

async fn next_text(socket: &mut WsSocket, phase: &str) -> Result<String, String> {
    loop {
        let message = tokio::time::timeout(STEP_TIMEOUT, socket.next())
            .await
            .map_err(|_| format!("通义千问语音识别{phase}超时"))?
            .ok_or_else(|| format!("通义千问语音识别{phase}时连接关闭"))?
            .map_err(|error| format!("通义千问语音识别连接中断: {error}"))?;
        if let Message::Text(text) = message {
            return Ok(text.to_string());
        }
    }
}

type WsSocket = crate::llm_network::CloudSocket;

/// 从服务端事件 JSON 中提取关键字段（header.event / header.error_message /
/// payload.output.sentence.{text, sentence_end, heartbeat}）。
struct ServerEvent {
    name: String,
    text: Option<String>,
    sentence_end: Option<bool>,
    heartbeat: Option<bool>,
    error: Option<String>,
}

fn parse_event(text: &str) -> Option<ServerEvent> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let name = value["header"]["event"].as_str()?.to_string();
    let error = value["header"]["error_message"].as_str()
        .map(|message| match value["header"]["error_code"].as_str() {
            Some(code) => format!("通义千问语音识别失败（{code}）：{message}"),
            None => format!("通义千问语音识别失败：{message}"),
        });
    let sentence = &value["payload"]["output"]["sentence"];
    Some(ServerEvent {
        text: sentence["text"].as_str().map(str::to_owned),
        sentence_end: sentence["sentence_end"].as_bool(),
        heartbeat: sentence["heartbeat"].as_bool(),
        name,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_maps_preset_base_and_passthrough() {
        assert_eq!(inference_ws_url("https://dashscope.aliyuncs.com"), "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
        assert_eq!(inference_ws_url("https://dashscope.aliyuncs.com/"), "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
        assert_eq!(inference_ws_url("wss://relay.invalid/v1"), "wss://relay.invalid/v1/api-ws/v1/inference");
    }

    #[test]
    fn parses_partial_final_failed_and_started_events() {
        let partial = parse_event(&serde_json::json!({
            "header": {"event": "result-generated", "task_id": "t"},
            "payload": {"output": {"sentence": {"text": "你好", "sentence_end": false, "heartbeat": false}}}
        }).to_string()).unwrap();
        assert_eq!(partial.name, "result-generated");
        assert_eq!(partial.text.as_deref(), Some("你好"));
        assert_eq!(partial.sentence_end, Some(false));

        let finished = parse_event(&serde_json::json!({
            "header": {"event": "result-generated"},
            "payload": {"output": {"sentence": {"text": "你好。", "sentence_end": true}}, "usage": {"duration": 2}}
        }).to_string()).unwrap();
        assert_eq!(finished.sentence_end, Some(true));

        let failed = parse_event(&serde_json::json!({
            "header": {"event": "task-failed", "error_code": "CLIENT_ERROR", "error_message": "bad model"}
        }).to_string()).unwrap();
        assert!(failed.error.unwrap().contains("bad model"));

        let started = parse_event(&serde_json::json!({"header": {"event": "task-started"}, "payload": {}}).to_string()).unwrap();
        assert_eq!(started.name, "task-started");
        assert!(parse_event("not json").is_none());
    }

    #[test]
    fn run_task_and_merge_shapes() {
        let run_task = serde_json::json!({
            "header": {"action": "run-task", "task_id": "t", "streaming": "duplex"},
            "payload": {"task_group": "audio", "task": "asr", "function": "recognition",
                "model": "paraformer-realtime-v2", "parameters": {"format": "pcm", "sample_rate": 16000}, "input": {}}
        });
        assert_eq!(run_task["header"]["action"], "run-task");
        assert_eq!(merge_text("你好，", "世界"), "你好，世界");
        assert_eq!(merge_text("  ", "  "), "");
    }
}
