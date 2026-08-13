use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const KEYRING_SERVICE: &str = "ai.solstice.iris.reasoning";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningSettings {
    pub provider: String,
    pub model: String,
    pub custom_base_url: String,
}

impl Default for ReasoningSettings {
    fn default() -> Self {
        Self {
            provider: "mock".to_string(),
            model: "gemini-3.6-flash".to_string(),
            custom_base_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCredentialStatus {
    pub configured: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningStatus {
    pub settings: ReasoningSettings,
    pub endpoint: Option<String>,
    pub credential: ReasoningCredentialStatus,
    pub configuration_source: String,
    pub secure_storage_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ConfigurationSource {
    App,
    Environment,
    Default,
}

impl ConfigurationSource {
    fn label(self) -> &'static str {
        match self {
            Self::App => "app_config",
            Self::Environment => "environment",
            Self::Default => "default",
        }
    }
}

pub(crate) struct RuntimeConfig {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) base_url: Option<Url>,
    pub(crate) api_key: String,
}

fn config_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|root| root.join("IRIS").join("reasoning").join("config.json"))
        .ok_or_else(|| "REASONING_APP_DATA_UNAVAILABLE".to_string())
}

fn read_app_settings() -> Result<Option<ReasoningSettings>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| "REASONING_SETTINGS_READ_FAILED".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("REASONING_SETTINGS_TOO_LARGE".to_string());
    }
    let settings =
        serde_json::from_slice(&bytes).map_err(|_| "REASONING_SETTINGS_INVALID".to_string())?;
    validate_settings(&settings)?;
    Ok(Some(settings))
}

fn replace_settings_file(temp: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())?;
    }
    fs::rename(temp, destination).map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())
}

fn write_app_settings(settings: &ReasoningSettings) -> Result<(), String> {
    validate_settings(settings)?;
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "REASONING_APP_DATA_UNAVAILABLE".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())?;
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|_| "REASONING_SETTINGS_INVALID".to_string())?;
    {
        let mut file =
            fs::File::create(&temp).map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())?;
        file.sync_all()
            .map_err(|_| "REASONING_SETTINGS_WRITE_FAILED".to_string())?;
    }
    replace_settings_file(&temp, &path)
}

fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:/".contains(character))
}

fn validate_settings(settings: &ReasoningSettings) -> Result<(), String> {
    if !matches!(
        settings.provider.as_str(),
        "mock" | "gemini" | "openai" | "custom"
    ) {
        return Err("REASONING_PROVIDER_INVALID".to_string());
    }
    if settings.provider != "mock" && !valid_model(&settings.model) {
        return Err("REASONING_MODEL_INVALID".to_string());
    }
    if settings.provider == "custom" {
        crate::validate_provider_url(&settings.custom_base_url, false)?;
    }
    Ok(())
}

fn environment_settings() -> Result<Option<ReasoningSettings>, String> {
    let Ok(provider) = std::env::var("IRIS_MODEL_PROVIDER") else {
        return Ok(None);
    };
    let provider = provider.trim().to_ascii_lowercase();
    let model = std::env::var("IRIS_MODEL").unwrap_or_else(|_| match provider.as_str() {
        "gemini" => "gemini-3.6-flash".to_string(),
        "openai" => "gpt-5-mini".to_string(),
        _ => String::new(),
    });
    let settings = match provider.as_str() {
        "mock" => ReasoningSettings::default(),
        "gemini" => ReasoningSettings {
            provider,
            model,
            custom_base_url: String::new(),
        },
        "openai" => ReasoningSettings {
            provider,
            model,
            custom_base_url: String::new(),
        },
        "openai-compatible" | "custom" => ReasoningSettings {
            provider: "custom".to_string(),
            model,
            custom_base_url: std::env::var("IRIS_BASE_URL").map_err(|_| {
                "IRIS_BASE_URL is required for the OpenAI-compatible provider.".to_string()
            })?,
        },
        _ => return Err("IRIS_MODEL_PROVIDER is unsupported.".to_string()),
    };
    validate_settings(&settings)?;
    Ok(Some(settings))
}

fn effective_settings() -> Result<(ReasoningSettings, ConfigurationSource), String> {
    if let Some(settings) = read_app_settings()? {
        return Ok((settings, ConfigurationSource::App));
    }
    if let Some(settings) = environment_settings()? {
        return Ok((settings, ConfigurationSource::Environment));
    }
    Ok((ReasoningSettings::default(), ConfigurationSource::Default))
}

fn endpoint_for(settings: &ReasoningSettings) -> Result<Option<Url>, String> {
    let endpoint = match settings.provider.as_str() {
        "mock" => return Ok(None),
        "gemini" => GEMINI_BASE_URL,
        "openai" => OPENAI_BASE_URL,
        "custom" => settings.custom_base_url.as_str(),
        _ => return Err("REASONING_PROVIDER_INVALID".to_string()),
    };
    crate::validate_provider_url(endpoint, false).map(Some)
}

fn credential_username(settings: &ReasoningSettings) -> Result<String, String> {
    match settings.provider.as_str() {
        "gemini" => Ok("gemini-api-key".to_string()),
        "openai" => Ok("openai-api-key".to_string()),
        "custom" => {
            let endpoint =
                endpoint_for(settings)?.ok_or_else(|| "REASONING_PROVIDER_INVALID".to_string())?;
            let canonical = endpoint.as_str().trim_end_matches('/');
            let digest = Sha256::digest(canonical.as_bytes());
            Ok(format!("custom-{:x}", digest)[..23].to_string())
        }
        _ => Err("REASONING_CREDENTIAL_NOT_APPLICABLE".to_string()),
    }
}

fn environment_credential(provider: &str) -> Option<String> {
    let names: &[&str] = match provider {
        "gemini" => &["IRIS_API_KEY", "GEMINI_API_KEY"],
        "openai" => &["IRIS_API_KEY", "OPENAI_API_KEY"],
        "custom" => &["IRIS_API_KEY"],
        _ => &[],
    };
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}

fn stored_credential(settings: &ReasoningSettings) -> Option<String> {
    let username = credential_username(settings).ok()?;
    crate::secure_store::get(KEYRING_SERVICE, &username)
}

fn effective_credential(
    settings: &ReasoningSettings,
    source: ConfigurationSource,
) -> Option<String> {
    let environment = (source == ConfigurationSource::Environment)
        .then(|| environment_credential(&settings.provider))
        .flatten();
    environment.or_else(|| stored_credential(settings))
}

fn credential_status(
    settings: &ReasoningSettings,
    source: ConfigurationSource,
) -> ReasoningCredentialStatus {
    if source == ConfigurationSource::Environment
        && environment_credential(&settings.provider).is_some()
    {
        return ReasoningCredentialStatus {
            configured: true,
            source: "environment".to_string(),
        };
    }
    if stored_credential(settings).is_some() {
        return ReasoningCredentialStatus {
            configured: true,
            source: "os_keyring".to_string(),
        };
    }
    ReasoningCredentialStatus {
        configured: false,
        source: "none".to_string(),
    }
}

fn status() -> Result<ReasoningStatus, String> {
    let (settings, source) = effective_settings()?;
    let endpoint = endpoint_for(&settings)?.map(|url| url.to_string());
    Ok(ReasoningStatus {
        credential: credential_status(&settings, source),
        settings,
        endpoint,
        configuration_source: source.label().to_string(),
        secure_storage_available: crate::secure_store::available(),
    })
}

pub(crate) fn runtime_config() -> Result<RuntimeConfig, String> {
    let (settings, source) = effective_settings()?;
    let base_url = endpoint_for(&settings)?;
    let api_key = effective_credential(&settings, source).unwrap_or_default();
    if matches!(settings.provider.as_str(), "gemini" | "openai") && api_key.is_empty() {
        return Err("REASONING_CREDENTIAL_REQUIRED".to_string());
    }
    Ok(RuntimeConfig {
        provider: settings.provider.clone(),
        model: settings.model,
        base_url,
        api_key,
    })
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "REASONING_CLIENT_UNAVAILABLE".to_string())
}

#[tauri::command]
pub async fn reasoning_get_status() -> Result<ReasoningStatus, String> {
    status()
}

#[tauri::command]
pub async fn reasoning_save_settings(
    mut settings: ReasoningSettings,
) -> Result<ReasoningStatus, String> {
    settings.provider = settings.provider.trim().to_ascii_lowercase();
    settings.model = settings.model.trim().to_string();
    settings.custom_base_url = settings
        .custom_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    if settings.provider != "custom" {
        settings.custom_base_url.clear();
    }
    write_app_settings(&settings)?;
    status()
}

#[tauri::command]
pub async fn reasoning_set_credential(credential: String) -> Result<ReasoningStatus, String> {
    let (settings, _) = effective_settings()?;
    let username = credential_username(&settings)?;
    let secret = credential.trim();
    if secret.len() < 8 || secret.len() > 512 || secret.chars().any(char::is_whitespace) {
        return Err("REASONING_CREDENTIAL_INVALID".to_string());
    }
    crate::secure_store::set(KEYRING_SERVICE, &username, secret).map_err(|error| {
        match error.as_str() {
            "CREDENTIAL_STORE_FAILED" => "REASONING_CREDENTIAL_STORE_FAILED".to_string(),
            _ => "REASONING_SECURE_STORAGE_UNAVAILABLE".to_string(),
        }
    })?;
    status()
}

#[tauri::command]
pub async fn reasoning_clear_credential() -> Result<ReasoningStatus, String> {
    let (settings, _) = effective_settings()?;
    let username = credential_username(&settings)?;
    crate::secure_store::delete(KEYRING_SERVICE, &username)
        .map_err(|_| "REASONING_CREDENTIAL_DELETE_FAILED".to_string())?;
    status()
}

#[tauri::command]
pub async fn reasoning_test_connection() -> Result<String, String> {
    let config = runtime_config()?;
    if config.provider == "mock" {
        return Ok("Offline mock provider is ready.".to_string());
    }
    let base_url = config
        .base_url
        .ok_or_else(|| "REASONING_PROVIDER_INVALID".to_string())?;
    let endpoint = format!("{}/models", base_url.as_str().trim_end_matches('/'));
    let mut request = client()?.get(endpoint);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(config.api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "REASONING_CONNECTION_FAILED".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "REASONING_CONNECTION_FAILED (HTTP {})",
            response.status().as_u16()
        ));
    }
    Ok(format!(
        "Connected to {} using model {}.",
        config.provider, config.model
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_offline_mock() {
        let settings = ReasoningSettings::default();
        validate_settings(&settings).unwrap();
        assert_eq!(settings.provider, "mock");
    }

    #[test]
    fn fixed_provider_origins_cannot_be_overridden() {
        let settings = ReasoningSettings {
            provider: "gemini".to_string(),
            model: "gemini-3.6-flash".to_string(),
            custom_base_url: "https://attacker.example/v1".to_string(),
        };
        assert_eq!(
            endpoint_for(&settings).unwrap().unwrap().as_str(),
            GEMINI_BASE_URL
        );
    }

    #[test]
    fn custom_credentials_are_bound_to_the_full_base_url() {
        let mut settings = ReasoningSettings {
            provider: "custom".to_string(),
            model: "local-model".to_string(),
            custom_base_url: "https://models.example/v1".to_string(),
        };
        let first = credential_username(&settings).unwrap();
        settings.custom_base_url = "https://other.example/v1".to_string();
        assert_ne!(first, credential_username(&settings).unwrap());
    }

    #[test]
    fn custom_remote_http_is_rejected_but_loopback_is_allowed() {
        let mut settings = ReasoningSettings {
            provider: "custom".to_string(),
            model: "local-model".to_string(),
            custom_base_url: "http://attacker.example/v1".to_string(),
        };
        assert!(validate_settings(&settings).is_err());
        settings.custom_base_url = "http://127.0.0.1:11434/v1".to_string();
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn status_serialization_contains_no_credential_value() {
        let value = ReasoningStatus {
            settings: ReasoningSettings::default(),
            endpoint: None,
            credential: ReasoningCredentialStatus {
                configured: true,
                source: "os_keyring".to_string(),
            },
            configuration_source: "app_config".to_string(),
            secure_storage_available: true,
        };
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("secretValue"));
        assert!(!serialized.contains("password"));
    }
}
