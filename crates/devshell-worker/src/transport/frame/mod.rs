mod codec;
mod stream;

use std::collections::HashMap;

#[cfg(test)]
pub use codec::RESET_CANCELLED;
pub use codec::{
    FRAME_MAX_DATA_SIZE, Frame, FrameDecoder, RESET_SERVICE_FAILED, RESET_UNSUPPORTED_SERVICE,
    encode_frame,
};
use stream::StreamState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameRole {
    #[cfg(test)]
    Opener,
    Acceptor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameEvent {
    Open {
        stream_id: u32,
        service: String,
        metadata: Vec<u8>,
    },
    Data {
        stream_id: u32,
    },
    Fin {
        stream_id: u32,
    },
    Reset {
        stream_id: u32,
        code: u16,
        message: String,
    },
}

#[derive(Debug)]
pub struct FrameProtocol {
    role: FrameRole,
    max_data_size: usize,
    #[cfg(test)]
    next_stream_id: u64,
    last_remote_stream_id: u32,
    streams: HashMap<u32, StreamState>,
}

impl FrameProtocol {
    pub fn new(role: FrameRole) -> Self {
        Self {
            role,
            max_data_size: FRAME_MAX_DATA_SIZE,
            #[cfg(test)]
            next_stream_id: 1,
            last_remote_stream_id: 0,
            streams: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn with_max_data_size(role: FrameRole, max_data_size: usize) -> Self {
        Self {
            max_data_size,
            ..Self::new(role)
        }
    }

    #[cfg(test)]
    pub fn open(
        &mut self,
        service: String,
        metadata: Vec<u8>,
        receive_window: u32,
    ) -> Result<(u32, Frame), String> {
        if self.role != FrameRole::Opener {
            return Err("Only the Frame opener can open a Service stream.".to_string());
        }
        if receive_window == 0 {
            return Err("Frame receive window must be positive.".to_string());
        }
        let stream_id = u32::try_from(self.next_stream_id)
            .map_err(|_| "Frame stream id space is exhausted.".to_string())?;
        self.next_stream_id += 1;
        self.streams
            .insert(stream_id, StreamState::new(true, 0, receive_window));
        Ok((
            stream_id,
            Frame::Open {
                stream_id,
                receive_window,
                service,
                metadata,
            },
        ))
    }

    pub fn accept_open(&mut self, stream_id: u32, receive_window: u32) -> Result<Frame, String> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        stream.accept(receive_window)?;
        Ok(Frame::Window {
            stream_id,
            credit_delta: receive_window,
        })
    }

    pub fn reject_open(
        &mut self,
        stream_id: u32,
        code: u16,
        message: String,
    ) -> Result<Frame, String> {
        self.streams
            .remove(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        Ok(Frame::Reset {
            stream_id,
            code,
            message,
        })
    }

    pub fn accept_frame(&mut self, frame: Frame) -> Result<Option<FrameEvent>, String> {
        if let Frame::Open {
            stream_id,
            receive_window,
            service,
            metadata,
        } = frame
        {
            if self.role != FrameRole::Acceptor {
                return Err("Frame opener received an OPEN frame.".to_string());
            }
            if stream_id <= self.last_remote_stream_id {
                return Err(format!("Frame stream id {stream_id} is not monotonic."));
            }
            if self.streams.contains_key(&stream_id) {
                return Err(format!("Frame stream {stream_id} is already open."));
            }
            self.last_remote_stream_id = stream_id;
            self.streams
                .insert(stream_id, StreamState::new(false, receive_window, 0));
            return Ok(Some(FrameEvent::Open {
                stream_id,
                service,
                metadata,
            }));
        }

        let stream_id = frame.stream_id();
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        if !stream.accepted {
            return Err(format!("Frame stream {stream_id} is not accepted yet."));
        }

        match frame {
            Frame::Data { data, .. } => {
                stream.push_data(data)?;
                Ok(Some(FrameEvent::Data { stream_id }))
            }
            Frame::Window { credit_delta, .. } => {
                stream.grant_send_credit(credit_delta)?;
                Ok(None)
            }
            Frame::Fin { .. } => {
                stream.mark_remote_fin()?;
                let event = FrameEvent::Fin { stream_id };
                self.cleanup(stream_id);
                Ok(Some(event))
            }
            Frame::Reset { code, message, .. } => {
                self.streams.remove(&stream_id);
                Ok(Some(FrameEvent::Reset {
                    stream_id,
                    code,
                    message,
                }))
            }
            Frame::Open { .. } => unreachable!(),
        }
    }

    pub fn next_data_frame(
        &mut self,
        stream_id: u32,
        data: &[u8],
    ) -> Result<Option<(usize, Frame)>, String> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        if !stream.accepted {
            return Err("Frame stream is not accepted.".to_string());
        }
        if stream.local_fin {
            return Err("Frame stream write side is closed.".to_string());
        }
        if data.is_empty() || stream.send_credit == 0 {
            return Ok(None);
        }
        let byte_len = stream.take_send_credit(self.max_data_size.min(data.len()));
        if byte_len == 0 {
            return Ok(None);
        }
        Ok(Some((
            byte_len,
            Frame::Data {
                stream_id,
                data: data[..byte_len].to_vec(),
            },
        )))
    }

    pub fn read_data(&mut self, stream_id: u32) -> Result<Option<Vec<u8>>, String> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        Ok(stream.pop_data())
    }

    pub fn consume(&mut self, stream_id: u32, byte_len: u32) -> Result<Option<Frame>, String> {
        if byte_len == 0 {
            return Ok(None);
        }
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        let window = if stream.remote_fin {
            None
        } else {
            stream.restore_receive_credit(byte_len)?;
            Some(Frame::Window {
                stream_id,
                credit_delta: byte_len,
            })
        };
        self.cleanup(stream_id);
        Ok(window)
    }

    #[cfg(test)]
    pub fn read(&mut self, stream_id: u32) -> Result<Option<(Vec<u8>, Option<Frame>)>, String> {
        let Some(data) = self.read_data(stream_id)? else {
            return Ok(None);
        };
        let byte_len =
            u32::try_from(data.len()).map_err(|_| "Frame DATA length exceeds u32.".to_string())?;
        let window = self.consume(stream_id, byte_len)?;
        Ok(Some((data, window)))
    }

    pub fn finish(&mut self, stream_id: u32) -> Result<Frame, String> {
        let stream = self
            .streams
            .get_mut(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        if stream.local_fin {
            return Err("Frame stream write side is already closed.".to_string());
        }
        stream.local_fin = true;
        let frame = Frame::Fin { stream_id };
        self.cleanup(stream_id);
        Ok(frame)
    }

    pub fn reset(&mut self, stream_id: u32, code: u16, message: String) -> Result<Frame, String> {
        self.streams
            .remove(&stream_id)
            .ok_or_else(|| format!("Frame references unknown stream {stream_id}."))?;
        Ok(Frame::Reset {
            stream_id,
            code,
            message,
        })
    }

    pub fn stream_open(&self, stream_id: u32) -> bool {
        self.streams.contains_key(&stream_id)
    }

    fn cleanup(&mut self, stream_id: u32) {
        if self
            .streams
            .get(&stream_id)
            .is_some_and(StreamState::closed)
        {
            self.streams.remove(&stream_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_pair(window: u32) -> (FrameProtocol, FrameProtocol, u32) {
        let mut opener = FrameProtocol::new(FrameRole::Opener);
        let mut acceptor = FrameProtocol::new(FrameRole::Acceptor);
        let (stream_id, open) = opener
            .open("network.tcp".into(), vec![7], window)
            .expect("open stream");
        assert_eq!(
            acceptor.accept_frame(open).expect("accept open frame"),
            Some(FrameEvent::Open {
                stream_id,
                service: "network.tcp".into(),
                metadata: vec![7],
            })
        );
        let window_frame = acceptor
            .accept_open(stream_id, window)
            .expect("accept service");
        opener
            .accept_frame(window_frame)
            .expect("grant opener credit");
        (opener, acceptor, stream_id)
    }

    #[test]
    fn moves_bytes_and_returns_credit_after_consumption() {
        let (mut opener, mut acceptor, stream_id) = open_pair(4);
        let (used, data) = opener
            .next_data_frame(stream_id, b"ping")
            .expect("make data")
            .expect("credit available");
        assert_eq!(used, 4);
        assert_eq!(
            acceptor.accept_frame(data).expect("accept data"),
            Some(FrameEvent::Data { stream_id })
        );
        let (bytes, window) = acceptor
            .read(stream_id)
            .expect("read stream")
            .expect("queued data");
        assert_eq!(bytes, b"ping");
        opener
            .accept_frame(window.expect("credit returned"))
            .expect("accept window");
        assert!(opener.next_data_frame(stream_id, b"x").unwrap().is_some());
    }

    #[test]
    fn fin_is_half_close_and_last_read_does_not_emit_late_window() {
        let (mut opener, mut acceptor, stream_id) = open_pair(8);
        let (_, data) = opener
            .next_data_frame(stream_id, b"request")
            .unwrap()
            .unwrap();
        acceptor.accept_frame(data).unwrap();
        let fin = opener.finish(stream_id).unwrap();
        acceptor.accept_frame(fin).unwrap();
        let (bytes, window) = acceptor.read(stream_id).unwrap().unwrap();
        assert_eq!(bytes, b"request");
        assert_eq!(window, None);
        assert!(acceptor.stream_open(stream_id));

        let (_, response) = acceptor
            .next_data_frame(stream_id, b"response")
            .unwrap()
            .unwrap();
        opener.accept_frame(response).unwrap();
        let fin = acceptor.finish(stream_id).unwrap();
        opener.accept_frame(fin).unwrap();
        let (bytes, window) = opener.read(stream_id).unwrap().unwrap();
        assert_eq!(bytes, b"response");
        assert_eq!(window, None);
        assert!(!opener.stream_open(stream_id));
        assert!(!acceptor.stream_open(stream_id));
    }

    #[test]
    fn wrong_direction_open_is_rejected() {
        let mut first = FrameProtocol::new(FrameRole::Opener);
        let mut second = FrameProtocol::new(FrameRole::Opener);
        let (_, open) = first.open("test".into(), Vec::new(), 1).unwrap();
        assert!(second.accept_frame(open).is_err());
    }

    #[test]
    fn data_is_bounded_by_credit_and_max_frame_chunk() {
        let mut opener = FrameProtocol::with_max_data_size(FrameRole::Opener, 2);
        let mut acceptor = FrameProtocol::new(FrameRole::Acceptor);
        let (stream_id, open) = opener.open("test".into(), Vec::new(), 3).unwrap();
        acceptor.accept_frame(open).unwrap();
        let window = acceptor.accept_open(stream_id, 3).unwrap();
        opener.accept_frame(window).unwrap();

        let (used, first) = opener
            .next_data_frame(stream_id, &[1, 2, 3, 4])
            .unwrap()
            .unwrap();
        assert_eq!(used, 2);
        acceptor.accept_frame(first).unwrap();
        let (used, second) = opener.next_data_frame(stream_id, &[3, 4]).unwrap().unwrap();
        assert_eq!(used, 1);
        acceptor.accept_frame(second).unwrap();
        assert!(opener.next_data_frame(stream_id, &[4]).unwrap().is_none());
    }
}
