use std::collections::VecDeque;

#[derive(Debug)]
pub(crate) struct StreamState {
    pub accepted: bool,
    pub send_credit: u32,
    pub receive_credit: u32,
    pub local_fin: bool,
    pub remote_fin: bool,
    incoming: VecDeque<Vec<u8>>,
}

impl StreamState {
    pub fn new(accepted: bool, send_credit: u32, receive_credit: u32) -> Self {
        Self {
            accepted,
            send_credit,
            receive_credit,
            local_fin: false,
            remote_fin: false,
            incoming: VecDeque::new(),
        }
    }

    pub fn closed(&self) -> bool {
        self.local_fin && self.remote_fin && self.incoming.is_empty()
    }

    pub fn accept(&mut self, receive_credit: u32) -> Result<(), String> {
        if self.accepted {
            return Err("Frame stream is already accepted.".to_string());
        }
        if receive_credit == 0 {
            return Err("Frame receive window must be positive.".to_string());
        }
        self.accepted = true;
        self.receive_credit = receive_credit;
        Ok(())
    }

    pub fn grant_send_credit(&mut self, delta: u32) -> Result<(), String> {
        self.send_credit = self
            .send_credit
            .checked_add(delta)
            .ok_or_else(|| "Frame send credit overflow.".to_string())?;
        Ok(())
    }

    pub fn take_send_credit(&mut self, max: usize) -> usize {
        let taken = max.min(self.send_credit as usize);
        self.send_credit -= taken as u32;
        taken
    }

    pub fn push_data(&mut self, data: Vec<u8>) -> Result<(), String> {
        if !self.accepted {
            return Err("Frame stream is not accepted yet.".to_string());
        }
        if self.remote_fin {
            return Err("Frame stream received DATA after FIN.".to_string());
        }
        let byte_len =
            u32::try_from(data.len()).map_err(|_| "Frame DATA length exceeds u32.".to_string())?;
        if byte_len > self.receive_credit {
            return Err("Frame stream exceeded receive credit.".to_string());
        }
        self.receive_credit -= byte_len;
        self.incoming.push_back(data);
        Ok(())
    }

    pub fn pop_data(&mut self) -> Option<Vec<u8>> {
        self.incoming.pop_front()
    }

    pub fn restore_receive_credit(&mut self, byte_len: u32) -> Result<(), String> {
        self.receive_credit = self
            .receive_credit
            .checked_add(byte_len)
            .ok_or_else(|| "Frame receive credit overflow.".to_string())?;
        Ok(())
    }

    pub fn mark_remote_fin(&mut self) -> Result<(), String> {
        if self.remote_fin {
            return Err("Frame stream received duplicate FIN.".to_string());
        }
        self.remote_fin = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_credit_bounds_buffering() {
        let mut stream = StreamState::new(true, 0, 2);
        stream.push_data(vec![1, 2]).expect("within credit");
        assert!(stream.push_data(vec![3]).is_err());
        let data = stream.pop_data().expect("queued data");
        assert_eq!(data, vec![1, 2]);
        stream.restore_receive_credit(2).expect("return credit");
        stream.push_data(vec![3]).expect("credit restored");
    }
}
