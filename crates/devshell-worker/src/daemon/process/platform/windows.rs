use std::ffi::{OsStr, OsString};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DETACHED_PROCESS, GetExitCodeProcess, OpenProcess, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, STARTUPINFOW, TerminateProcess,
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

pub fn spawn_daemon_process(
    executable: &Path,
    current_directory: &Path,
    environment_overrides: &[(&str, &OsStr)],
) -> Result<u32, String> {
    let application_name = null_terminated(executable.as_os_str());
    let mut command_line = quoted_command_line(executable.as_os_str());
    let current_directory = null_terminated(current_directory.as_os_str());
    let environment = environment_block(environment_overrides);
    let mut startup_info = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process_information = PROCESS_INFORMATION::default();
    let result = unsafe {
        CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            DETACHED_PROCESS
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            current_directory.as_ptr(),
            &mut startup_info,
            &mut process_information,
        )
    };
    if result == 0 {
        return Err(format!(
            "failed to spawn detached daemon process: {}",
            std::io::Error::last_os_error()
        ));
    }
    let process_id = process_information.dwProcessId;
    unsafe {
        CloseHandle(process_information.hThread);
        CloseHandle(process_information.hProcess);
    }
    Ok(process_id)
}

pub fn configure_child_process(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

fn null_terminated(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn quoted_command_line(executable: &OsStr) -> Vec<u16> {
    let mut command_line = Vec::new();
    command_line.push('"' as u16);
    command_line.extend(executable.encode_wide());
    command_line.push('"' as u16);
    command_line.push(0);
    command_line
}

fn environment_block(overrides: &[(&str, &OsStr)]) -> Vec<u16> {
    let mut environment = std::env::vars_os().collect::<Vec<(OsString, OsString)>>();
    for (key, value) in overrides {
        environment.retain(|(existing, _)| !existing.to_string_lossy().eq_ignore_ascii_case(key));
        environment.push((OsString::from(key), value.to_os_string()));
    }
    environment.sort_by(|(left, _), (right, _)| {
        left.to_string_lossy()
            .to_ascii_uppercase()
            .cmp(&right.to_string_lossy().to_ascii_uppercase())
    });

    let mut block = Vec::new();
    for (key, value) in environment {
        block.extend(key.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}
