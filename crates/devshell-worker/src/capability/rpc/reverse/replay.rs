use sha2::{Digest, Sha256};

pub(super) const REQUEST_CACHE_SIZE: usize = 1024;

pub(super) fn request_cache_key(request_id: &str, frame: &[u8]) -> String {
    let digest = Sha256::digest(frame);
    format!("{request_id}:{}", hex(&digest))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
