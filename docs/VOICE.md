# Voice

IRIS is voice-first, but voice is an interaction channel rather than an authority channel.

```text
Native microphone
    -> Rust VAD and bounded WAV utterance
    -> Rust voice provider host
    -> transcript
    -> normal IRIS message/agent loop
    -> ToolRegistry and native policy
    -> response
    -> Rust TTS provider or system speech
```

## Modes

- **Tap to talk** is the default. Enable the microphone, speak one utterance, and capture returns to standby after transcription. Ambient speech is not continuously sent to a provider.
- **Cloud wake word** keeps native VAD active. Each detected utterance is transcribed by the selected cloud provider and then checked for a configured wake phrase. This may consume credits and send ambient speech off-device. It is intentionally opt-in.

Microphone capture and spoken replies are separate controls. Tap-to-talk can return the microphone to standby without muting the response. Select **Silent** as the speech-output provider only when audible replies are not wanted.

IRIS v0.2.0 does not bundle a local wake-word model. Adding one later should happen before cloud STT so non-wake ambient audio remains local.

## Providers

Speech to text:

- OpenAI: `whisper-1`, `gpt-4o-mini-transcribe`, or `gpt-4o-transcribe`
- ElevenLabs: Scribe (`scribe_v2` by default)

After selecting a provider and storing its credential, click **Save voice settings** and confirm **Listening: ready**. Credential storage does not implicitly activate a provider.

Text to speech:

- Windows/system speech (credential-free)
- OpenAI TTS, including supported built-in or eligible custom voice IDs
- ElevenLabs TTS with a user-provided voice ID

Provider contracts follow the official [OpenAI Audio API](https://developers.openai.com/api/reference/resources/audio) and [ElevenLabs API](https://elevenlabs.io/docs/api-reference/introduction).

## Credentials

On Windows, Settings stores keys in Windows Credential Manager through the native Rust keyring adapter. The renderer receives only `configured`, `source`, and secure-store availability status. There is no command for reading a secret back.

Source builds may use:

```env
IRIS_OPENAI_API_KEY=
IRIS_ELEVENLABS_API_KEY=
```

`OPENAI_API_KEY` and `ELEVENLABS_API_KEY` are accepted as fallback names. Environment credentials take precedence over OS-vault entries. Keys are never written to voice configuration, localStorage, capability packages, audit records, or logs.

Non-secret settings are stored under the local IRIS application-data directory in `IRIS/voice/config.json`.

## Network boundary

- OpenAI voice credentials are attached only to `https://api.openai.com`.
- ElevenLabs voice credentials are attached only to `https://api.elevenlabs.io`.
- The renderer cannot provide an endpoint to either native command.
- Authenticated redirects are disabled.
- Audio input, transcript responses, speech text, and generated audio are bounded.
- Provider failure messages do not include response bodies or credentials.

## Custom voices

A voice ID is configuration, not a secret. IRIS does not ship the private Solstice voice ID or voice samples. Users may select an installed system voice, an OpenAI built-in/eligible custom voice, or paste an ElevenLabs voice ID associated with their own account and consent rights.

## Failure behavior

STT failure returns IRIS to standby and shows a configuration/provider error. It does not invent a transcript. If paid TTS fails, IRIS may fall back to local system speech so the conversation remains audible; this fallback receives response text but no provider credential.
