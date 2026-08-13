#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
fn initialize() -> bool {
    static INITIALIZED: OnceLock<bool> = OnceLock::new();
    *INITIALIZED.get_or_init(|| match windows_native_keyring_store::Store::new() {
        Ok(store) => {
            keyring_core::set_default_store(store);
            true
        }
        Err(_) => false,
    })
}

pub fn available() -> bool {
    #[cfg(target_os = "windows")]
    {
        initialize()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

pub fn get(service: &str, username: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if !initialize() {
            return None;
        }
        let entry = keyring_core::Entry::new(service, username).ok()?;
        entry.get_password().ok().filter(|value| !value.is_empty())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = service;
        let _ = username;
        None
    }
}

pub fn set(service: &str, username: &str, secret: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !initialize() {
            return Err("SECURE_STORAGE_UNAVAILABLE".to_string());
        }
        let entry = keyring_core::Entry::new(service, username)
            .map_err(|_| "SECURE_STORAGE_UNAVAILABLE".to_string())?;
        entry
            .set_password(secret)
            .map_err(|_| "CREDENTIAL_STORE_FAILED".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = service;
        let _ = username;
        let _ = secret;
        Err("SECURE_STORAGE_UNAVAILABLE".to_string())
    }
}

pub fn delete(service: &str, username: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !initialize() {
            return Err("SECURE_STORAGE_UNAVAILABLE".to_string());
        }
        let entry = keyring_core::Entry::new(service, username)
            .map_err(|_| "SECURE_STORAGE_UNAVAILABLE".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err("CREDENTIAL_DELETE_FAILED".to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = service;
        let _ = username;
        Err("SECURE_STORAGE_UNAVAILABLE".to_string())
    }
}
