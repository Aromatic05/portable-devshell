use std::collections::VecDeque;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

pub(in crate::capability::process) const READ_CHUNK: usize = 16 * 1024;
const RETAIN_FRAMES: usize = 4096;
const RETAIN_BYTES: usize = 4 * 1024 * 1024;
const PAGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) enum OutputChannel {
    Stdout,
    Stderr,
    Terminal,
}

struct Chunk {
    seq: u64,
    channel: OutputChannel,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct OutputFrame {
    seq: u64,
    channel: OutputChannel,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct OutputPage {
    oldest_seq: u64,
    latest_seq: u64,
    gap: bool,
    frames: Vec<OutputFrame>,
}

#[derive(Default)]
pub(in crate::capability::process) struct OutputJournal {
    latest_seq: u64,
    bytes: usize,
    chunks: VecDeque<Chunk>,
}

impl OutputJournal {
    pub fn append(&mut self, channel: OutputChannel, bytes: &[u8]) {
        self.latest_seq += 1;
        self.bytes += bytes.len();
        self.chunks.push_back(Chunk {
            seq: self.latest_seq,
            channel,
            bytes: bytes.to_vec(),
        });
        while self.bytes > RETAIN_BYTES || self.chunks.len() > RETAIN_FRAMES {
            if let Some(chunk) = self.chunks.pop_front() {
                self.bytes -= chunk.bytes.len();
            }
        }
    }

    pub fn latest_seq(&self) -> u64 {
        self.latest_seq
    }

    pub fn read_after(&self, from_seq: u64) -> OutputPage {
        let oldest_seq = self
            .chunks
            .front()
            .map_or(self.latest_seq + 1, |chunk| chunk.seq);
        let mut bytes = 0;
        let frames = self
            .chunks
            .iter()
            .filter(|chunk| chunk.seq > from_seq)
            .take_while(|chunk| {
                bytes += chunk.bytes.len();
                bytes <= PAGE_BYTES
            })
            .map(|chunk| OutputFrame {
                seq: chunk.seq,
                channel: chunk.channel,
                data_base64: STANDARD.encode(&chunk.bytes),
            })
            .collect();
        OutputPage {
            oldest_seq,
            latest_seq: self.latest_seq,
            gap: from_seq < oldest_seq - 1,
            frames,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_history_reports_evicted_sequences_without_consuming_output() {
        let mut journal = OutputJournal::default();
        let chunk = vec![b'x'; READ_CHUNK];
        let retained_chunks = RETAIN_BYTES / READ_CHUNK;
        for _ in 0..=retained_chunks {
            journal.append(OutputChannel::Stdout, &chunk);
        }
        let first = journal.read_after(0);
        assert!(first.gap);
        assert_eq!(first.oldest_seq, 2);
        assert_eq!(first.latest_seq, retained_chunks as u64 + 1);
        assert_eq!(first.frames[0].seq, 2);
        assert_eq!(first.frames.len(), PAGE_BYTES / READ_CHUNK);
        let second = journal.read_after(0);
        assert_eq!(second.frames[0].seq, first.frames[0].seq);
        let next = journal.read_after(first.frames.last().unwrap().seq);
        assert!(!next.gap);
        assert_eq!(next.frames[0].seq, first.frames.last().unwrap().seq + 1);
    }
}
