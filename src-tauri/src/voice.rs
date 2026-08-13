use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

const OPENAI_ORIGIN: &str = "https://api.openai.com";
const ELEVENLABS_ORIGIN: &str = "https://api.elevenlabs.io";
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 1024 * 1024;
const MAX_SPEECH_BYTES: usize = 20 * 1024 * 1024;
const MAX_TTS_CHARACTERS: usize = 4096;
const KEYRING_SERVICE: &str = "ai.solstice.iris.voice";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub input_mode: String,
    pub stt_provider: String,
    pub stt_model: String,
    pub tts_provider: String,
    pub tts_model: String,
    pub voice: String,
    pub elevenlabs_voice_id: String,
    pub language: String,
    pub speed: f32,
    pub wake_words: Vec<String>,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            input_mode: "tap_to_talk".to_string(),
            stt_provider: "disabled".to_string(),
            stt_model: "whisper-1".to_string(),
            tts_provider: "system".to_string(),
            tts_model: "gpt-4o-mini-tts".to_string(),
            voice: "alloy".to_string(),
            elevenlabs_voice_id: String::new(),
            language: "en".to_string(),
            speed: 1.0,
            wake_words: vec!["hey iris".to_string(), "iris".to_string()],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCredentialStatus {
    pub configured: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub settings: VoiceSettings,
    pub openai: VoiceCredentialStatus,
    pub elevenlabs: VoiceCredentialStatus,
    pub secure_storage_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResponse {
    pub text: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechResponse {
    pub provider: String,
    pub audio_base64: Option<String>,
    pub mime_type: Option<String>,
    pub sample_rate: Option<u32>,
    pub system_voice: Option<String>,
    pub speed: f32,
}

fn config_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|root| root.join("IRIS").join("voice").join("config.json"))
        .ok_or_else(|| "VOICE_APP_DATA_UNAVAILABLE".to_string())
}

fn read_settings() -> Result<VoiceSettings, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(VoiceSettings::default());
    }
    let bytes = fs::read(path).map_err(|_| "VOICE_SETTINGS_READ_FAILED".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("VOICE_SETTINGS_TOO_LARGE".to_string());
    }
    let settings: VoiceSettings =
        serde_json::from_slice(&bytes).map_err(|_| "VOICE_SETTINGS_INVALID".to_string())?;
    validate_settings(&settings)?;
    Ok(settings)
}

fn write_settings(settings: &VoiceSettings) -> Result<(), String> {
    validate_settings(settings)?;
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "VOICE_APP_DATA_UNAVAILABLE".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())?;
    let temp = path.with_extension("tmp");
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|_| "VOICE_SETTINGS_INVALID".to_string())?;
    {
        let mut file =
            fs::File::create(&temp).map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())?;
        file.sync_all()
            .map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())?;
    }
    replace_settings_file(&temp, &path)
}

fn replace_settings_file(
    temp: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    // std::fs::rename does not replace an existing destination on Windows.
    // The file contains non-secret preferences; credentials live in the OS vault.
    if destination.exists() {
        fs::remove_file(destination).map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())?;
    }
    fs::rename(temp, destination).map_err(|_| "VOICE_SETTINGS_WRITE_FAILED".to_string())
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn validate_settings(settings: &VoiceSettings) -> Result<(), String> {
    if !matches!(settings.input_mode.as_str(), "tap_to_talk" | "cloud_wake") {
        return Err("VOICE_INPUT_MODE_INVALID".to_string());
    }
    if !matches!(
        settings.stt_provider.as_str(),
        "disabled" | "openai" | "elevenlabs"
    ) {
        return Err("VOICE_STT_PROVIDER_INVALID".to_string());
    }
    if !matches!(
        settings.tts_provider.as_str(),
        "disabled" | "system" | "openai" | "elevenlabs"
    ) {
        return Err("VOICE_TTS_PROVIDER_INVALID".to_string());
    }
    if !valid_identifier(&settings.stt_model, 80)
        || !valid_identifier(&settings.tts_model, 80)
        || !valid_identifier(&settings.language, 16)
    {
        return Err("VOICE_PROVIDER_SETTING_INVALID".to_string());
    }
    if !settings.voice.is_empty() && !valid_identifier(&settings.voice, 128) {
        return Err("VOICE_NAME_INVALID".to_string());
    }
    if !settings.elevenlabs_voice_id.is_empty()
        && !valid_identifier(&settings.elevenlabs_voice_id, 128)
    {
        return Err("VOICE_ID_INVALID".to_string());
    }
    if !(0.25..=4.0).contains(&settings.speed) || !settings.speed.is_finite() {
        return Err("VOICE_SPEED_INVALID".to_string());
    }
    if settings.wake_words.is_empty() || settings.wake_words.len() > 8 {
        return Err("VOICE_WAKE_WORDS_INVALID".to_string());
    }
    if settings
        .wake_words
        .iter()
        .any(|word| word.trim().is_empty() || word.len() > 40 || word.contains(['\r', '\n']))
    {
        return Err("VOICE_WAKE_WORDS_INVALID".to_string());
    }
    Ok(())
}

fn provider_username(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("openai-api-key"),
        "elevenlabs" => Ok("elevenlabs-api-key"),
        _ => Err("VOICE_CREDENTIAL_PROVIDER_INVALID".to_string()),
    }
}

fn environment_credential(provider: &str) -> Option<String> {
    let names: &[&str] = match provider {
        "openai" => &["IRIS_OPENAI_API_KEY", "OPENAI_API_KEY"],
        "elevenlabs" => &["IRIS_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY"],
        _ => &[],
    };
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}

fn keyring_credential(provider: &str) -> Option<String> {
    let username = provider_username(provider).ok()?;
    crate::secure_store::get(KEYRING_SERVICE, username)
}

fn credential(provider: &str) -> Result<String, String> {
    environment_credential(provider)
        .or_else(|| keyring_credential(provider))
        .ok_or_else(|| {
            format!(
                "VOICE_{}_CREDENTIAL_REQUIRED",
                provider.to_ascii_uppercase()
            )
        })
}

fn credential_status(provider: &str) -> VoiceCredentialStatus {
    if environment_credential(provider).is_some() {
        return VoiceCredentialStatus {
            configured: true,
            source: "environment".to_string(),
        };
    }
    if keyring_credential(provider).is_some() {
        return VoiceCredentialStatus {
            configured: true,
            source: "os_keyring".to_string(),
        };
    }
    VoiceCredentialStatus {
        configured: false,
        source: "none".to_string(),
    }
}

fn secure_storage_available() -> bool {
    crate::secure_store::available()
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "VOICE_CLIENT_UNAVAILABLE".to_string())
}

fn decode_audio(audio_base64: &str) -> Result<Vec<u8>, String> {
    if audio_base64.len() > (MAX_AUDIO_BYTES * 4 / 3) + 8 {
        return Err("VOICE_AUDIO_TOO_LARGE".to_string());
    }
    let audio = STANDARD
        .decode(audio_base64)
        .map_err(|_| "VOICE_AUDIO_INVALID".to_string())?;
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
        return Err("VOICE_AUDIO_INVALID".to_string());
    }
    Ok(audio)
}

async fn response_bytes(
    response: reqwest::Response,
    maximum: usize,
    failure: &str,
) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{} (HTTP {})", failure, status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err("VOICE_PROVIDER_RESPONSE_TOO_LARGE".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "VOICE_PROVIDER_RESPONSE_INVALID".to_string())?;
    if bytes.len() > maximum {
        return Err("VOICE_PROVIDER_RESPONSE_TOO_LARGE".to_string());
    }
    Ok(bytes.to_vec())
}

async fn transcribe_openai(settings: &VoiceSettings, audio: Vec<u8>) -> Result<String, String> {
    let key = credential("openai")?;
    let mut form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio)
                .file_name("speech.wav")
                .mime_str("audio/wav")
                .map_err(|_| "VOICE_AUDIO_INVALID".to_string())?,
        )
        .text("model", settings.stt_model.clone())
        .text("response_format", "json");
    if !settings.language.is_empty() {
        form = form.text("language", settings.language.clone());
    }
    let response = client()?
        .post(format!("{OPENAI_ORIGIN}/v1/audio/transcriptions"))
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "VOICE_TRANSCRIPTION_REQUEST_FAILED".to_string())?;
    let bytes =
        response_bytes(response, MAX_TRANSCRIPT_BYTES, "VOICE_TRANSCRIPTION_FAILED").await?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "VOICE_TRANSCRIPTION_INVALID".to_string())?;
    value
        .get("text")
        .and_then(|text| text.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "VOICE_TRANSCRIPTION_EMPTY".to_string())
}

async fn transcribe_elevenlabs(settings: &VoiceSettings, audio: Vec<u8>) -> Result<String, String> {
    let key = credential("elevenlabs")?;
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio)
                .file_name("speech.wav")
                .mime_str("audio/wav")
                .map_err(|_| "VOICE_AUDIO_INVALID".to_string())?,
        )
        .text("model_id", settings.stt_model.clone());
    let response = client()?
        .post(format!("{ELEVENLABS_ORIGIN}/v1/speech-to-text"))
        .header("xi-api-key", key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "VOICE_TRANSCRIPTION_REQUEST_FAILED".to_string())?;
    let bytes =
        response_bytes(response, MAX_TRANSCRIPT_BYTES, "VOICE_TRANSCRIPTION_FAILED").await?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "VOICE_TRANSCRIPTION_INVALID".to_string())?;
    value
        .get("text")
        .and_then(|text| text.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "VOICE_TRANSCRIPTION_EMPTY".to_string())
}

async fn synthesize_openai(settings: &VoiceSettings, text: &str) -> Result<Vec<u8>, String> {
    let key = credential("openai")?;
    let voice = if settings.voice.starts_with("voice_") {
        serde_json::json!({ "id": settings.voice })
    } else {
        serde_json::Value::String(settings.voice.clone())
    };
    let response = client()?
        .post(format!("{OPENAI_ORIGIN}/v1/audio/speech"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": settings.tts_model,
            "input": text,
            "voice": voice,
            "response_format": "wav",
            "speed": settings.speed,
        }))
        .send()
        .await
        .map_err(|_| "VOICE_SYNTHESIS_REQUEST_FAILED".to_string())?;
    response_bytes(response, MAX_SPEECH_BYTES, "VOICE_SYNTHESIS_FAILED").await
}

async fn synthesize_elevenlabs(settings: &VoiceSettings, text: &str) -> Result<Vec<u8>, String> {
    if settings.elevenlabs_voice_id.is_empty() {
        return Err("VOICE_ELEVENLABS_VOICE_ID_REQUIRED".to_string());
    }
    let key = credential("elevenlabs")?;
    let endpoint = format!(
        "{ELEVENLABS_ORIGIN}/v1/text-to-speech/{}?output_format=mp3_44100_128",
        settings.elevenlabs_voice_id
    );
    let response = client()?
        .post(endpoint)
        .header("xi-api-key", key)
        .json(&serde_json::json!({
            "text": text,
            "model_id": settings.tts_model,
        }))
        .send()
        .await
        .map_err(|_| "VOICE_SYNTHESIS_REQUEST_FAILED".to_string())?;
    response_bytes(response, MAX_SPEECH_BYTES, "VOICE_SYNTHESIS_FAILED").await
}

#[tauri::command]
pub async fn voice_get_status() -> Result<VoiceStatus, String> {
    Ok(VoiceStatus {
        settings: read_settings()?,
        openai: credential_status("openai"),
        elevenlabs: credential_status("elevenlabs"),
        secure_storage_available: secure_storage_available(),
    })
}

#[tauri::command]
pub async fn voice_save_settings(mut settings: VoiceSettings) -> Result<VoiceStatus, String> {
    settings.wake_words = settings
        .wake_words
        .iter()
        .map(|word| word.trim().to_ascii_lowercase())
        .filter(|word| !word.is_empty())
        .collect();
    write_settings(&settings)?;
    voice_get_status().await
}

#[tauri::command]
pub async fn voice_set_credential(
    provider: String,
    credential: String,
) -> Result<VoiceStatus, String> {
    let username = provider_username(&provider)?;
    let secret = credential.trim();
    if secret.len() < 8 || secret.len() > 512 || secret.chars().any(char::is_whitespace) {
        return Err("VOICE_CREDENTIAL_INVALID".to_string());
    }
    crate::secure_store::set(KEYRING_SERVICE, username, secret).map_err(|error| {
        match error.as_str() {
            "CREDENTIAL_STORE_FAILED" => "VOICE_CREDENTIAL_STORE_FAILED".to_string(),
            _ => "VOICE_SECURE_STORAGE_UNAVAILABLE".to_string(),
        }
    })?;
    voice_get_status().await
}

#[tauri::command]
pub async fn voice_clear_credential(provider: String) -> Result<VoiceStatus, String> {
    let username = provider_username(&provider)?;
    let _ = crate::secure_store::delete(KEYRING_SERVICE, username);
    voice_get_status().await
}

#[tauri::command]
pub async fn voice_transcribe(audio_base64: String) -> Result<TranscriptionResponse, String> {
    let settings = read_settings()?;
    let audio = decode_audio(&audio_base64)?;
    let text = match settings.stt_provider.as_str() {
        "openai" => transcribe_openai(&settings, audio).await?,
        "elevenlabs" => transcribe_elevenlabs(&settings, audio).await?,
        "disabled" => return Err("VOICE_STT_NOT_CONFIGURED".to_string()),
        _ => return Err("VOICE_STT_PROVIDER_INVALID".to_string()),
    };
    Ok(TranscriptionResponse {
        text,
        provider: settings.stt_provider,
    })
}

#[tauri::command]
pub async fn voice_synthesize(text: String) -> Result<SpeechResponse, String> {
    let settings = read_settings()?;
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_TTS_CHARACTERS {
        return Err("VOICE_TEXT_INVALID".to_string());
    }
    match settings.tts_provider.as_str() {
        "disabled" => Err("VOICE_TTS_DISABLED".to_string()),
        "system" => Ok(SpeechResponse {
            provider: "system".to_string(),
            audio_base64: None,
            mime_type: None,
            sample_rate: None,
            system_voice: (!settings.voice.is_empty()).then_some(settings.voice),
            speed: settings.speed,
        }),
        "openai" => {
            let audio = synthesize_openai(&settings, text).await?;
            Ok(SpeechResponse {
                provider: "openai".to_string(),
                audio_base64: Some(STANDARD.encode(audio)),
                mime_type: Some("audio/wav".to_string()),
                sample_rate: Some(24_000),
                system_voice: None,
                speed: settings.speed,
            })
        }
        "elevenlabs" => {
            let audio = synthesize_elevenlabs(&settings, text).await?;
            Ok(SpeechResponse {
                provider: "elevenlabs".to_string(),
                audio_base64: Some(STANDARD.encode(audio)),
                mime_type: Some("audio/mpeg".to_string()),
                sample_rate: Some(44_100),
                system_voice: None,
                speed: settings.speed,
            })
        }
        _ => Err("VOICE_TTS_PROVIDER_INVALID".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_safe_and_valid() {
        let settings = VoiceSettings::default();
        validate_settings(&settings).unwrap();
        assert_eq!(settings.input_mode, "tap_to_talk");
        assert_eq!(settings.stt_provider, "disabled");
        assert_eq!(settings.tts_provider, "system");
    }

    #[test]
    fn rejects_untrusted_provider_and_voice_identifiers() {
        let mut settings = VoiceSettings {
            stt_provider: "https://attacker.example".to_string(),
            ..VoiceSettings::default()
        };
        assert_eq!(
            validate_settings(&settings).unwrap_err(),
            "VOICE_STT_PROVIDER_INVALID"
        );
        settings.stt_provider = "openai".to_string();
        settings.elevenlabs_voice_id = "../../secret".to_string();
        assert_eq!(
            validate_settings(&settings).unwrap_err(),
            "VOICE_ID_INVALID"
        );
    }

    #[test]
    fn rejects_unbounded_wake_words_and_speed() {
        let mut settings = VoiceSettings {
            speed: 8.0,
            ..VoiceSettings::default()
        };
        assert_eq!(
            validate_settings(&settings).unwrap_err(),
            "VOICE_SPEED_INVALID"
        );
        settings.speed = 1.0;
        settings.wake_words = vec!["wake\ninstall authority".to_string()];
        assert_eq!(
            validate_settings(&settings).unwrap_err(),
            "VOICE_WAKE_WORDS_INVALID"
        );
    }

    #[test]
    fn status_serialization_never_contains_secret_material() {
        let status = VoiceStatus {
            settings: VoiceSettings::default(),
            openai: VoiceCredentialStatus {
                configured: true,
                source: "os_keyring".to_string(),
            },
            elevenlabs: VoiceCredentialStatus {
                configured: false,
                source: "none".to_string(),
            },
            secure_storage_available: true,
        };
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("credentialValue"));
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn audio_payloads_are_bounded_and_validated() {
        assert_eq!(decode_audio("").unwrap_err(), "VOICE_AUDIO_INVALID");
        assert_eq!(
            decode_audio("not base64").unwrap_err(),
            "VOICE_AUDIO_INVALID"
        );
        assert_eq!(
            decode_audio(&STANDARD.encode(b"RIFFtest")).unwrap(),
            b"RIFFtest"
        );
    }

    #[test]
    fn settings_file_can_be_replaced_on_windows() {
        let root =
            std::env::temp_dir().join(format!("iris-voice-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("config.json");
        let first = root.join("first.tmp");
        let second = root.join("second.tmp");
        fs::write(&first, b"first").unwrap();
        replace_settings_file(&first, &destination).unwrap();
        fs::write(&second, b"second").unwrap();
        replace_settings_file(&second, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }
}
