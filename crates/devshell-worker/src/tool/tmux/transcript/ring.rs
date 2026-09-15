use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};

const MAGIC: &[u8; 8] = b"DSHTMUX2";
const HEADER_BYTES: usize = 40;
const SEQUENCE_OFFSET: usize = 8;
const BASE_OFFSET: usize = 16;
const END_OFFSET: usize = 24;
const CAPACITY_OFFSET: usize = 32;
const SNAPSHOT_RETRIES: usize = 64;

#[derive(Debug)]
pub struct RingSnapshot {
    pub base: u64,
    pub end: u64,
    data: Vec<u8>,
}

impl RingSnapshot {
    pub fn is_empty(&self) -> bool {
        self.base == self.end
    }

    pub fn bytes_from(&self, offset: u64) -> &[u8] {
        let start = offset.max(self.base).min(self.end);
        &self.data[(start - self.base) as usize..]
    }
}

pub struct RingWriter {
    mapping: SharedMapping,
    capacity: u64,
}

impl RingWriter {
    pub fn open(name: &str, capacity: u64, start_offset: u64) -> std::io::Result<Self> {
        if capacity == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ring capacity must be greater than zero",
            ));
        }
        let capacity_bytes = usize::try_from(capacity).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ring capacity is too large",
            )
        })?;
        let mapping_bytes = HEADER_BYTES.checked_add(capacity_bytes).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ring mapping size overflow",
            )
        })?;
        let file = open_shared(name, true)?;
        resize_shared(&file, mapping_bytes as u64)?;
        let mut mapping = map_shared(&file, mapping_bytes, true)?;
        initialize_header(&mut mapping, start_offset, capacity);
        Ok(Self { mapping, capacity })
    }

    pub fn append(&mut self, logical_offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let (base, end, capacity) = read_header_fields(self.mapping.as_slice())?;
        if capacity != self.capacity || end != logical_offset {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("ring stream offset mismatch: expected {end}, received {logical_offset}"),
            ));
        }

        let incoming_end = logical_offset.saturating_add(bytes.len() as u64);
        let keep_start = incoming_end.saturating_sub(self.capacity);
        let skipped = keep_start.saturating_sub(logical_offset) as usize;
        let retained = &bytes[skipped.min(bytes.len())..];
        let retained_offset = logical_offset + skipped as u64;
        let writing = begin_write(&self.mapping);
        write_wrapped(
            self.mapping.as_mut_slice(),
            retained_offset,
            retained,
            self.capacity,
        );
        let next_base = base.max(incoming_end.saturating_sub(self.capacity));
        write_header_fields(
            self.mapping.as_mut_slice(),
            next_base,
            incoming_end,
            self.capacity,
        );
        finish_write(&self.mapping, writing);
        Ok(())
    }
}

pub fn snapshot(name: &str) -> std::io::Result<Option<RingSnapshot>> {
    let file = match open_shared(name, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mapping_bytes = shared_len(&file)?;
    if mapping_bytes < HEADER_BYTES {
        return Err(invalid_data("ring mapping is smaller than its header"));
    }
    let mapping = map_shared(&file, mapping_bytes, false)?;
    Ok(Some(snapshot_mapping(&mapping)?))
}

pub fn remove(name: &str) -> std::io::Result<()> {
    remove_shared(name)
}

fn snapshot_mapping(mapping: &SharedMapping) -> std::io::Result<RingSnapshot> {
    for _ in 0..SNAPSHOT_RETRIES {
        let before = sequence(mapping).load(Ordering::SeqCst);
        if before % 2 != 0 {
            std::hint::spin_loop();
            continue;
        }
        let fields = read_header_fields(mapping.as_slice());
        let after_header = sequence(mapping).load(Ordering::SeqCst);
        if before != after_header || after_header % 2 != 0 {
            std::hint::spin_loop();
            continue;
        }
        let (base, end, capacity) = match fields {
            Ok(fields) => fields,
            Err(_) if before == 0 => {
                std::hint::spin_loop();
                continue;
            }
            Err(error) => return Err(error),
        };
        validate_range(mapping.as_slice(), base, end, capacity)?;
        let data = read_wrapped(mapping.as_slice(), base, end - base, capacity);
        let after = sequence(mapping).load(Ordering::SeqCst);
        if before == after && after % 2 == 0 {
            return Ok(RingSnapshot { base, end, data });
        }
        std::hint::spin_loop();
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        "ring changed while taking a snapshot",
    ))
}

fn initialize_header(mapping: &mut SharedMapping, offset: u64, capacity: u64) {
    sequence(mapping).store(1, Ordering::SeqCst);
    mapping.as_mut_slice()[..MAGIC.len()].copy_from_slice(MAGIC);
    write_header_fields(mapping.as_mut_slice(), offset, offset, capacity);
    sequence(mapping).store(2, Ordering::SeqCst);
}

fn begin_write(mapping: &SharedMapping) -> u64 {
    let current = sequence(mapping).load(Ordering::SeqCst);
    let writing = if current % 2 == 0 {
        current.wrapping_add(1)
    } else {
        current.wrapping_add(2)
    };
    sequence(mapping).store(writing, Ordering::SeqCst);
    writing
}

fn finish_write(mapping: &SharedMapping, writing: u64) {
    sequence(mapping).store(writing.wrapping_add(1), Ordering::SeqCst);
}

fn sequence(mapping: &SharedMapping) -> &AtomicU64 {
    debug_assert!(mapping.as_slice().len() >= HEADER_BYTES);
    // mmap returns page-aligned memory and this field starts at byte 8.
    unsafe { &*(mapping.as_slice().as_ptr().add(SEQUENCE_OFFSET) as *const AtomicU64) }
}

fn write_header_fields(bytes: &mut [u8], base: u64, end: u64, capacity: u64) {
    bytes[BASE_OFFSET..END_OFFSET].copy_from_slice(&base.to_le_bytes());
    bytes[END_OFFSET..CAPACITY_OFFSET].copy_from_slice(&end.to_le_bytes());
    bytes[CAPACITY_OFFSET..HEADER_BYTES].copy_from_slice(&capacity.to_le_bytes());
}

fn read_header_fields(bytes: &[u8]) -> std::io::Result<(u64, u64, u64)> {
    if bytes.len() < HEADER_BYTES {
        return Err(invalid_data("ring mapping is smaller than its header"));
    }
    if &bytes[..MAGIC.len()] != MAGIC {
        return Err(invalid_data("ring header magic is invalid"));
    }
    let base = u64::from_le_bytes(bytes[BASE_OFFSET..END_OFFSET].try_into().unwrap());
    let end = u64::from_le_bytes(bytes[END_OFFSET..CAPACITY_OFFSET].try_into().unwrap());
    let capacity = u64::from_le_bytes(bytes[CAPACITY_OFFSET..HEADER_BYTES].try_into().unwrap());
    if capacity == 0 {
        return Err(invalid_data("ring capacity is zero"));
    }
    Ok((base, end, capacity))
}

fn validate_range(bytes: &[u8], base: u64, end: u64, capacity: u64) -> std::io::Result<()> {
    let capacity_bytes = usize::try_from(capacity)
        .map_err(|_| invalid_data("ring capacity does not fit this platform"))?;
    let expected = HEADER_BYTES
        .checked_add(capacity_bytes)
        .ok_or_else(|| invalid_data("ring mapping size overflow"))?;
    if expected > bytes.len() {
        return Err(invalid_data(
            "ring capacity exceeds its shared-memory mapping",
        ));
    }
    if end < base || end - base > capacity {
        return Err(invalid_data(
            "ring header contains an invalid retained range",
        ));
    }
    Ok(())
}

fn write_wrapped(mapping: &mut [u8], logical_offset: u64, bytes: &[u8], capacity: u64) {
    if bytes.is_empty() {
        return;
    }
    let start = (logical_offset % capacity) as usize;
    let capacity = capacity as usize;
    let first = bytes.len().min(capacity - start);
    mapping[HEADER_BYTES + start..HEADER_BYTES + start + first].copy_from_slice(&bytes[..first]);
    if first < bytes.len() {
        mapping[HEADER_BYTES..HEADER_BYTES + bytes.len() - first].copy_from_slice(&bytes[first..]);
    }
}

fn read_wrapped(mapping: &[u8], logical_offset: u64, len: u64, capacity: u64) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }
    let len = len as usize;
    let start = (logical_offset % capacity) as usize;
    let capacity = capacity as usize;
    let first = len.min(capacity - start);
    let mut output = Vec::with_capacity(len);
    output.extend_from_slice(&mapping[HEADER_BYTES + start..HEADER_BYTES + start + first]);
    if first < len {
        output.extend_from_slice(&mapping[HEADER_BYTES..HEADER_BYTES + len - first]);
    }
    output
}

fn invalid_data(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

#[cfg(all(unix, not(target_os = "android")))]
struct SharedMapping {
    pointer: std::ptr::NonNull<u8>,
    len: usize,
}

#[cfg(all(unix, not(target_os = "android")))]
impl SharedMapping {
    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), self.len) }
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.len) }
    }
}

#[cfg(all(unix, not(target_os = "android")))]
impl Drop for SharedMapping {
    fn drop(&mut self) {
        let pointer = self.pointer.cast();
        let _ = unsafe { nix::sys::mman::munmap(pointer, self.len) };
    }
}

#[cfg(all(unix, not(target_os = "android")))]
fn map_shared(file: &File, len: usize, writable: bool) -> std::io::Result<SharedMapping> {
    use std::num::NonZeroUsize;

    use nix::sys::mman::{MapFlags, ProtFlags, mmap};

    let length = NonZeroUsize::new(len).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "ring mapping is empty")
    })?;
    let prot = ProtFlags::PROT_READ
        | if writable {
            ProtFlags::PROT_WRITE
        } else {
            ProtFlags::empty()
        };
    let pointer = unsafe { mmap(None, length, prot, MapFlags::MAP_SHARED, file, 0) }
        .map_err(nix_error)?
        .cast();
    Ok(SharedMapping { pointer, len })
}

#[cfg(all(unix, not(target_os = "android")))]
fn shared_len(file: &File) -> std::io::Result<usize> {
    usize::try_from(file.metadata()?.len())
        .map_err(|_| invalid_data("ring mapping length does not fit this platform"))
}

#[cfg(all(unix, not(target_os = "android")))]
fn open_shared(name: &str, create: bool) -> std::io::Result<File> {
    use nix::fcntl::OFlag;
    use nix::sys::mman::shm_open;
    use nix::sys::stat::Mode;

    let mut flags = OFlag::O_RDWR | OFlag::O_CLOEXEC;
    if create {
        flags |= OFlag::O_CREAT | OFlag::O_TRUNC;
    }
    let fd = shm_open(name, flags, Mode::from_bits_truncate(0o600)).map_err(nix_error)?;
    Ok(File::from(fd))
}

#[cfg(all(unix, not(target_os = "android")))]
fn resize_shared(file: &File, len: u64) -> std::io::Result<()> {
    nix::unistd::ftruncate(file, len as i64).map_err(nix_error)
}

#[cfg(all(unix, not(target_os = "android")))]
fn remove_shared(name: &str) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::sys::mman::shm_unlink;

    match shm_unlink(name) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(error) => Err(nix_error(error)),
    }
}

#[cfg(all(unix, not(target_os = "android")))]
fn nix_error(error: nix::errno::Errno) -> std::io::Error {
    std::io::Error::from_raw_os_error(error as i32)
}

#[cfg(any(not(unix), target_os = "android"))]
fn open_shared(_name: &str, _create: bool) -> std::io::Result<File> {
    Err(shared_memory_unsupported())
}

#[cfg(any(not(unix), target_os = "android"))]
fn resize_shared(_file: &File, _len: u64) -> std::io::Result<()> {
    Err(shared_memory_unsupported())
}

#[cfg(any(not(unix), target_os = "android"))]
struct SharedMapping {
    bytes: Vec<u8>,
}

#[cfg(any(not(unix), target_os = "android"))]
impl SharedMapping {
    fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}

#[cfg(any(not(unix), target_os = "android"))]
fn map_shared(_file: &File, _len: usize, _writable: bool) -> std::io::Result<SharedMapping> {
    Err(shared_memory_unsupported())
}

#[cfg(any(not(unix), target_os = "android"))]
fn shared_len(_file: &File) -> std::io::Result<usize> {
    Err(shared_memory_unsupported())
}

#[cfg(any(not(unix), target_os = "android"))]
fn remove_shared(_name: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(any(not(unix), target_os = "android"))]
fn shared_memory_unsupported() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "tmux volatile transcript buffers require POSIX shared memory",
    )
}

#[cfg(all(test, unix, not(target_os = "android")))]
mod tests {
    use super::{RingWriter, remove, snapshot};
    use uuid::Uuid;

    fn ring_name() -> String {
        let id = Uuid::new_v4().simple().to_string();
        format!("/dsh-test-{}", &id[..20])
    }

    #[test]
    fn ring_keeps_the_latest_bytes_across_wraps() {
        let name = ring_name();
        let mut writer = RingWriter::open(&name, 8, 16).unwrap();
        writer.append(16, b"abcd").unwrap();
        writer.append(20, b"efghij").unwrap();

        let snapshot = snapshot(&name).unwrap().unwrap();
        assert_eq!(snapshot.base, 18);
        assert_eq!(snapshot.end, 26);
        assert_eq!(snapshot.bytes_from(18), b"cdefghij");
        assert_eq!(snapshot.bytes_from(22), b"ghij");
        remove(&name).unwrap();
    }

    #[test]
    fn ring_accepts_a_single_write_larger_than_capacity() {
        let name = ring_name();
        let mut writer = RingWriter::open(&name, 5, 10).unwrap();
        writer.append(10, b"0123456789").unwrap();

        let snapshot = snapshot(&name).unwrap().unwrap();
        assert_eq!((snapshot.base, snapshot.end), (15, 20));
        assert_eq!(snapshot.bytes_from(15), b"56789");
        remove(&name).unwrap();
    }
}
