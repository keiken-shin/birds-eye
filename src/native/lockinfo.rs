//! Who is holding a locked file? Windows answers this properly via the
//! Restart Manager: register the path in a session and it names the processes
//! with open handles — no admin rights needed for typical cases.

#[cfg(windows)]
pub fn file_lock_holders(path: &str) -> Vec<String> {
    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };

    unsafe {
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
            return Vec::new();
        }

        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let file_ptrs = [wide.as_ptr()];
        let mut names: Vec<String> = Vec::new();

        if RmRegisterResources(
            session,
            1,
            file_ptrs.as_ptr(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
        ) == 0
        {
            let mut needed = 0u32;
            let mut count = 0u32;
            let mut reboot = 0u32;
            let first = RmGetList(session, &mut needed, &mut count, std::ptr::null_mut(), &mut reboot);
            if first == ERROR_MORE_DATA && needed > 0 {
                let mut infos: Vec<RM_PROCESS_INFO> = vec![std::mem::zeroed(); needed as usize];
                count = needed;
                if RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reboot) == 0 {
                    infos.truncate(count as usize);
                    names = infos
                        .iter()
                        .map(|info| {
                            let end = info
                                .strAppName
                                .iter()
                                .position(|&c| c == 0)
                                .unwrap_or(info.strAppName.len());
                            String::from_utf16_lossy(&info.strAppName[..end])
                        })
                        .filter(|name| !name.is_empty())
                        .collect();
                }
            }
        }

        RmEndSession(session);
        names.sort();
        names.dedup();
        names
    }
}

#[cfg(not(windows))]
pub fn file_lock_holders(_path: &str) -> Vec<String> {
    Vec::new()
}
