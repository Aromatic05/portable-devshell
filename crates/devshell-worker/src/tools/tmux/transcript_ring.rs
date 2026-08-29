use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};

const MAGIC: &[u8; 8] = b"DSHTMUX1";
const HEADER_BYTES: u64 = 32;

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
    file: File,
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
        let mut file = open_shared(name, true)?;
        resize_shared(&file, HEADER_BYTES + capacity)?;
        write_header(&mut file, start_offset, start_offset, capacity)?;
        file.flush()?;
        Ok(Self { file, capacity })
    }

    pub fn append(&mut self, logical_offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.file.lock()?;
        let result = self.append_locked(logical_offset, bytes);
        let unlock = self.file.unlock();
        result.and(unlock)
    }

    fn append_locked(&mut self, logical_offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        let (base, end, capacity) = read_header(&mut self.file)?;
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
        write_wrapped(&mut self.file, retained_offset, retained, self.capacity)?;

        let next_base = base.max(incoming_end.saturating_sub(self.capacity));
        write_header(&mut self.file, next_base, incoming_end, self.capacity)?;
        self.file.flush()
    }
}

pub fn snapshot(name: &str) -> std::io::Result<Option<RingSnapshot>> {
    let mut file = match open_shared(name, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    file.lock_shared()?;
    let result = snapshot_locked(&mut file);
    let unlock = file.unlock();
    match (result, unlock) {
        (Ok(snapshot), Ok(())) => Ok(Some(snapshot)),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

pub fn remove(name: &str) -> std::io::Result<()> {
    remove_shared(name)
}

fn snapshot_locked(file: &mut File) -> std::io::Result<RingSnapshot> {
    let (base, end, capacity) = read_header(file)?;
    if end < base || end - base > capacity {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "ring header contains an invalid retained range",
        ));
    }
    let len = (end - base) as usize;
    let mut data = vec![0_u8; len];
    read_wrapped(file, base, &mut data, capacity)?;
    Ok(RingSnapshot { base, end, data })
}

fn write_header(file: &mut File, base: u64, end: u64, capacity: u64) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(MAGIC)?;
    file.write_all(&base.to_le_bytes())?;
    file.write_all(&end.to_le_bytes())?;
    file.write_all(&capacity.to_le_bytes())?;
    Ok(())
}

fn read_header(file: &mut File) -> std::io::Result<(u64, u64, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; HEADER_BYTES as usize];
    file.read_exact(&mut header)?;
    if &header[..MAGIC.len()] != MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "ring header magic is invalid",
        ));
    }
    let base = u64::from_le_bytes(header[8..16].try_into().unwrap());
    let end = u64::from_le_bytes(header[16..24].try_into().unwrap());
    let capacity = u64::from_le_bytes(header[24..32].try_into().unwrap());
    if capacity == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "ring capacity is zero",
        ));
    }
    Ok((base, end, capacity))
}

fn write_wrapped(
    file: &mut File,
    logical_offset: u64,
    bytes: &[u8],
    capacity: u64,
) -> std::io::Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    let start = logical_offset % capacity;
    let first = bytes.len().min((capacity - start) as usize);
    file.seek(SeekFrom::Start(HEADER_BYTES + start))?;
    file.write_all(&bytes[..first])?;
    if first < bytes.len() {
        file.seek(SeekFrom::Start(HEADER_BYTES))?;
        file.write_all(&bytes[first..])?;
    }
    Ok(())
}

fn read_wrapped(
    file: &mut File,
    logical_offset: u64,
    output: &mut [u8],
    capacity: u64,
) -> std::io::Result<()> {
    if output.is_empty() {
        return Ok(());
    }
    let start = logical_offset % capacity;
    let first = output.len().min((capacity - start) as usize);
    file.seek(SeekFrom::Start(HEADER_BYTES + start))?;
    file.read_exact(&mut output[..first])?;
    if first < output.len() {
        file.seek(SeekFrom::Start(HEADER_BYTES))?;
        file.read_exact(&mut output[first..])?;
    }
    Ok(())
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
        format!("/devshell-test-tmux-{}", Uuid::new_v4().simple())
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
