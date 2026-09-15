use serde_json::Value;

pub(super) fn decode_response_frame(output: &[u8], expected_id: Option<&str>) -> Value {
    let mut offset = 0usize;
    while offset + 4 <= output.len() {
        let length = u32::from_be_bytes(output[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        assert!(
            offset + length <= output.len(),
            "truncated framed RPC output"
        );
        let frame: Value = serde_json::from_slice(&output[offset..offset + length]).unwrap();
        offset += length;
        if frame["type"] != "response" {
            continue;
        }
        if expected_id.is_none_or(|id| frame["id"] == id) {
            return frame;
        }
    }
    panic!("RPC response not found in framed output for id {expected_id:?}");
}
