use std::process::Command;

use std::os::windows::process::CommandExt;
use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS, GetExitCodeProcess, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
};

pub fn process_is_running(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }

    let mut exit_code = 0_u32;
    let success = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    unsafe {
        CloseHandle(handle);
    }
    success && exit_code == STILL_ACTIVE as u32
}

pub fn terminate_process(pid: u32, _force: bool) -> Result<(), String> {
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return Ok(());
    }

    let result = unsafe { TerminateProcess(handle, 1) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        return Err(format!(
            "failed to terminate process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub fn terminate_process_group(pid: i32, force: bool) -> Result<(), String> {
    let pid = pid as u32;
    if !process_is_running(pid) {
        return Ok(());
    }

    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("failed to start taskkill for process tree {pid}: {error}"))?;
    if output.status.success() || !process_is_running(pid) {
        return Ok(());
    }

    Err(format!(
        "failed to terminate process tree {pid}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

pub fn configure_daemon_command(command: &mut Command) {
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

pub fn configure_child_process(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}
