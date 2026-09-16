use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CACHE_CONTROL};
use serde::{Deserialize, Serialize};

use crate::daemon::log::append_log;

use super::{ReverseConnector, ReverseFramePayload, reverse_endpoint};

impl ReverseConnector {
    pub(super) fn run_sse(&self, client: &Client, generation: u64) -> Result<(), String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/events", false)?;
        let response = client
            .get(endpoint)
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.device_token),
            )
            .header("x-devshell-instance", self.instance.as_str())
            .header("x-devshell-generation", generation.to_string())
            .header(CACHE_CONTROL, "no-cache")
            .send()
            .map_err(|error| format!("failed to connect reverse SSE: {error}"))?
            .error_for_status()
            .map_err(|error| format!("reverse SSE rejected: {error}"))?;

        self.payload.prepare_connection()?;
        append_log(
            &self.paths,
            &format!("reverse connection established transport=sse generation={generation}"),
        )?;

        let upload_error = Arc::new(Mutex::new(None));
        let uploader = SseUploader::spawn(
            self.clone(),
            client.clone(),
            generation,
            Arc::clone(&upload_error),
        );
        let mut event_name = String::new();
        let mut data = String::new();
        let reader = BufReader::new(response);

        for line in reader.lines() {
            if self.payload.is_stopping() {
                return Ok(());
            }
            if let Some(error) = take_upload_error(&upload_error)? {
                return Err(error);
            }
            let line = line.map_err(|error| format!("failed to read reverse SSE: {error}"))?;
            if line.is_empty() {
                if event_name == "frame" && !data.is_empty() {
                    let frame = BASE64
                        .decode(data.as_bytes())
                        .map_err(|error| format!("invalid reverse SSE frame: {error}"))?;
                    if let Some(response) = self.payload.accept_inbound(&frame)? {
                        self.payload.queue_outbound(response)?;
                    }
                }
                event_name.clear();
                data.clear();
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim());
            }
        }

        drop(uploader);
        if let Some(error) = take_upload_error(&upload_error)? {
            return Err(error);
        }
        Err("reverse SSE stream ended".to_string())
    }

    pub(super) fn post_upstream(
        &self,
        client: &Client,
        generation: u64,
        seq: u64,
        frame: &[u8],
    ) -> Result<(), String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/frames", false)?;
        let body = UpstreamBatch {
            generation,
            frames: vec![UpstreamFrame {
                seq,
                frame: BASE64.encode(frame),
            }],
        };
        let response = client
            .post(endpoint)
            .timeout(Duration::from_secs(30))
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.device_token),
            )
            .header("x-devshell-instance", self.instance.as_str())
            .header("x-devshell-generation", generation.to_string())
            .json(&body)
            .send()
            .map_err(|error| format!("failed to upload reverse frame: {error}"))?
            .error_for_status()
            .map_err(|error| format!("reverse frame upload rejected: {error}"))?
            .json::<UpstreamAck>()
            .map_err(|error| format!("invalid reverse frame acknowledgement: {error}"))?;
        if response.generation != generation || response.accepted_through < seq {
            return Err(
                "reverse frame acknowledgement did not accept the uploaded frame".to_string(),
            );
        }
        Ok(())
    }
}

struct SseUploader {
    handle: Option<thread::JoinHandle<()>>,
    payload: Arc<ReverseFramePayload>,
    running: Arc<AtomicBool>,
}

impl SseUploader {
    fn spawn(
        connector: ReverseConnector,
        client: Client,
        generation: u64,
        upload_error: Arc<Mutex<Option<String>>>,
    ) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let payload = Arc::clone(&connector.payload);
        let thread_running = Arc::clone(&running);
        let thread_payload = Arc::clone(&payload);
        let handle = thread::spawn(move || {
            let mut upstream_seq = 0_u64;
            while thread_running.load(Ordering::SeqCst) && !connector.payload.is_stopping() {
                let response = match thread_payload.wait_pop_outbound(Duration::from_millis(100)) {
                    Ok(response) => response,
                    Err(error) => {
                        set_upload_error(&upload_error, error);
                        return;
                    }
                };
                let Some(response) = response else {
                    continue;
                };
                let frame = response.frame.clone();
                upstream_seq = upstream_seq.saturating_add(1);
                if let Err(error) =
                    connector.post_upstream(&client, generation, upstream_seq, &frame)
                {
                    let _ = thread_payload.requeue_front(response);
                    set_upload_error(&upload_error, error);
                    return;
                }
            }
        });
        Self {
            handle: Some(handle),
            payload,
            running,
        }
    }
}

impl Drop for SseUploader {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.payload.wake_outbound();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn set_upload_error(upload_error: &Mutex<Option<String>>, error: String) {
    if let Ok(mut current) = upload_error.lock() {
        *current = Some(error);
    }
}

fn take_upload_error(upload_error: &Mutex<Option<String>>) -> Result<Option<String>, String> {
    Ok(upload_error
        .lock()
        .map_err(|_| "reverse upload error lock poisoned".to_string())?
        .take())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamBatch {
    generation: u64,
    frames: Vec<UpstreamFrame>,
}

#[derive(Serialize)]
struct UpstreamFrame {
    seq: u64,
    frame: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamAck {
    accepted_through: u64,
    generation: u64,
}
