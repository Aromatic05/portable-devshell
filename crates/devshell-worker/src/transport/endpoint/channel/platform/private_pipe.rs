//! A Process Host accepts only local connections from its owning Windows user.

use std::fs::File;
use std::io::{Error, Result};
use std::mem::size_of;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{GENERIC_ALL, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAce, GetLengthSid, GetTokenInformation,
    InitializeAcl, InitializeSecurityDescriptor, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(super) fn create(name: &[u16]) -> Result<File> {
    // All backing memory remains live until CreateNamedPipeW copies the
    // descriptor. Word-aligned storage also satisfies TOKEN_USER/ACL alignment.
    unsafe {
        let mut raw: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(Error::last_os_error());
        }
        let _token = OwnedHandle::from_raw_handle(raw);
        let mut bytes = 0u32;
        GetTokenInformation(raw, TokenUser, null_mut(), 0, &mut bytes);
        if bytes == 0 {
            return Err(Error::last_os_error());
        }
        let mut user = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(raw, TokenUser, user.as_mut_ptr().cast(), bytes, &mut bytes) == 0 {
            return Err(Error::last_os_error());
        }
        let sid = (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        let acl_bytes = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()
            + GetLengthSid(sid) as usize;
        let mut storage = vec![0usize; acl_bytes.div_ceil(size_of::<usize>())];
        let acl = storage.as_mut_ptr().cast::<ACL>();
        if InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) == 0
            || AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, sid) == 0
        {
            return Err(Error::last_os_error());
        }
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let descriptor = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
        // SECURITY_DESCRIPTOR_REVISION = 1.
        if InitializeSecurityDescriptor(descriptor, 1) == 0
            || SetSecurityDescriptorDacl(descriptor, 1, acl, 0) == 0
        {
            return Err(Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(Error::last_os_error());
        }
        Ok(File::from_raw_handle(handle))
    }
}
