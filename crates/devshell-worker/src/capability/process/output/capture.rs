//! The transcript is bounded for interactive reads. Captures retain a larger
//! prefix of each stream so a short command cannot lose its output merely
//! because it emitted data faster than the Worker could read the journal.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;

use super::journal::OutputChannel;

const STREAM_LIMIT: usize = 256 * 1024 * 1024;
const INSTANCE_LIMIT: usize = 1024 * 1024 * 1024;
const PAGE_LIMIT: usize = 256 * 1024;

#[derive(Default)]
pub(in crate::capability::process) struct CaptureBudget(AtomicUsize);

impl CaptureBudget {
    fn reserve(&self, requested: usize) -> usize {
        let mut reserved = 0;
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                reserved = requested.min(INSTANCE_LIMIT.saturating_sub(used));
                Some(used + reserved)
            });
        reserved
    }

    fn release(&self, bytes: usize) {
        self.0.fetch_sub(bytes, Ordering::AcqRel);
    }
}

struct Capture {
    file: File,
    budget: Arc<CaptureBudget>,
    source: usize,
    stored: usize,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct CapturePage {
    pub(in crate::capability::process) source_bytes: usize,
    pub(in crate::capability::process) stored_bytes: usize,
    pub(in crate::capability::process) truncated: bool,
    pub(in crate::capability::process) data_base64: String,
    pub(in crate::capability::process) latest_seq: u64,
}

impl Capture {
    fn new(root: &Path, budget: Arc<CaptureBudget>) -> std::io::Result<Self> {
        Ok(Self {
            file: tempfile::tempfile_in(root)?,
            budget,
            source: 0,
            stored: 0,
            truncated: false,
        })
    }

    fn append(&mut self, bytes: &[u8]) {
        self.source = self.source.saturating_add(bytes.len());
        if self.truncated {
            return;
        }
        let keep = self
            .budget
            .reserve(bytes.len().min(STREAM_LIMIT - self.stored));
        if self
            .file
            .seek(SeekFrom::Start(self.stored as u64))
            .and_then(|_| self.file.write_all(&bytes[..keep]))
            .is_ok()
        {
            self.stored += keep;
            self.truncated = keep < bytes.len();
        } else {
            self.budget.release(keep);
            self.truncated = true;
        }
    }

    fn read(&mut self, offset: usize, limit: usize) -> std::io::Result<CapturePage> {
        let count = self
            .stored
            .saturating_sub(offset)
            .min(limit)
            .min(PAGE_LIMIT);
        let mut bytes = vec![0; count];
        if count != 0 {
            self.file.seek(SeekFrom::Start(offset as u64))?;
            self.file.read_exact(&mut bytes)?;
        }
        Ok(CapturePage {
            source_bytes: self.source,
            stored_bytes: self.stored,
            truncated: self.truncated,
            data_base64: STANDARD.encode(bytes),
            latest_seq: 0,
        })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.budget.release(self.stored);
    }
}

pub(in crate::capability::process) struct Captures {
    stdout: Capture,
    stderr: Capture,
}

impl Captures {
    pub fn new(root: &Path, budget: Arc<CaptureBudget>) -> std::io::Result<Self> {
        Ok(Self {
            stdout: Capture::new(root, Arc::clone(&budget))?,
            stderr: Capture::new(root, budget)?,
        })
    }

    pub fn append(&mut self, channel: OutputChannel, bytes: &[u8]) {
        match channel {
            OutputChannel::Stdout | OutputChannel::Terminal => self.stdout.append(bytes),
            OutputChannel::Stderr => self.stderr.append(bytes),
        }
    }

    pub fn read(
        &mut self,
        channel: OutputChannel,
        offset: usize,
        limit: usize,
    ) -> std::io::Result<CapturePage> {
        match channel {
            OutputChannel::Stdout | OutputChannel::Terminal => self.stdout.read(offset, limit),
            OutputChannel::Stderr => self.stderr.read(offset, limit),
        }
    }
}
