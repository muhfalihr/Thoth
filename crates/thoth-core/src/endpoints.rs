//! Single source of truth for every AI provider REST root.
//!
//! No call site may write a provider host literally. The same URL used to appear in the provider
//! client, in the settings-identity fingerprint, and in a config default — so pointing Thoth at a
//! gateway, a self-hosted replacement, or a moved endpoint meant hunting duplicates across crates,
//! and any one that was missed kept calling the old host silently.
//!
//! Every root is overridable by environment variable, using the same `THOTH_` contract Scout reads
//! (`scout/lib/env.ts`); the constants below are only the fallback when nothing is configured.
//! Roots exposed in `config.toml` (`llm.novita_base_url`, `llm.vllm_base_url`, …) keep config as
//! their source of truth and take their *default* from here, so the literal still lives once.

/// Trailing slashes are stripped so callers can always join with a leading-slash path.
fn resolve(variable: &str, default: &str) -> String {
    std::env::var(variable)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

macro_rules! endpoint {
    ($fn_name:ident, $const_name:ident, $variable:literal, $default:literal) => {
        pub const $const_name: &str = $default;
        #[doc = concat!("Root for ", $variable, " (default `", $default, "`).")]
        pub fn $fn_name() -> String {
            resolve($variable, $default)
        }
    };
}

endpoint!(groq, GROQ_BASE_URL, "THOTH_GROQ_BASE_URL", "https://api.groq.com/openai/v1");
endpoint!(openai, OPENAI_BASE_URL, "THOTH_OPENAI_BASE_URL", "https://api.openai.com/v1");
endpoint!(claude, CLAUDE_BASE_URL, "THOTH_CLAUDE_BASE_URL", "https://api.anthropic.com/v1");
endpoint!(
    gemini,
    GEMINI_BASE_URL,
    "THOTH_GEMINI_BASE_URL",
    "https://generativelanguage.googleapis.com/v1beta"
);
endpoint!(novita, NOVITA_BASE_URL, "THOTH_NOVITA_BASE_URL", "https://api.novita.ai/openai");
endpoint!(
    openrouter,
    OPENROUTER_BASE_URL,
    "THOTH_OPENROUTER_BASE_URL",
    "https://openrouter.ai/api"
);
endpoint!(together, TOGETHER_BASE_URL, "THOTH_TOGETHER_BASE_URL", "https://api.together.xyz");
endpoint!(
    fireworks,
    FIREWORKS_BASE_URL,
    "THOTH_FIREWORKS_BASE_URL",
    "https://api.fireworks.ai/inference"
);
endpoint!(
    elevenlabs,
    ELEVENLABS_BASE_URL,
    "THOTH_ELEVENLABS_BASE_URL",
    "https://api.elevenlabs.io/v1"
);

pub fn groq_chat_completions() -> String {
    format!("{}/chat/completions", groq())
}

pub fn groq_audio_transcriptions() -> String {
    format!("{}/audio/transcriptions", groq())
}

pub fn openai_chat_completions() -> String {
    format!("{}/chat/completions", openai())
}

pub fn openai_audio_speech() -> String {
    format!("{}/audio/speech", openai())
}

/// Root WITHOUT the version segment, for the OpenAI-compatible callers that store a pre-`/v1` base
/// (`vector_db.embed_base_url`, `llm.novita_base_url`) and append `/v1/embeddings` themselves.
pub fn openai_versionless() -> String {
    openai().trim_end_matches("/v1").trim_end_matches('/').to_owned()
}

pub fn claude_messages() -> String {
    format!("{}/messages", claude())
}

/// Gemini keys travel in the query string, not a header — the model is part of the path.
pub fn gemini_generate_content(model: &str, api_key: &str) -> String {
    format!("{}/models/{model}:generateContent?key={api_key}", gemini())
}

pub fn gemini_embed_content(model: &str, api_key: &str) -> String {
    format!("{}/models/{model}:embedContent?key={api_key}", gemini())
}

pub fn elevenlabs_text_to_speech(voice_id: &str) -> String {
    format!("{}/text-to-speech/{voice_id}", elevenlabs())
}

pub fn elevenlabs_text_to_speech_with_timestamps(voice_id: &str) -> String {
    format!("{}/with-timestamps", elevenlabs_text_to_speech(voice_id))
}

pub fn elevenlabs_voices() -> String {
    format!("{}/voices", elevenlabs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply_when_unset() {
        // SAFETY: single-threaded test, and the variable is scoped to this assertion.
        unsafe { std::env::remove_var("THOTH_GROQ_BASE_URL") };
        assert_eq!(groq_chat_completions(), format!("{GROQ_BASE_URL}/chat/completions"));
    }

    #[test]
    fn override_redirects_every_path_built_from_the_root() {
        // SAFETY: single-threaded test; a dedicated variable no other test reads.
        unsafe { std::env::set_var("THOTH_ELEVENLABS_BASE_URL", "https://gateway.test/eleven/") };
        assert_eq!(
            elevenlabs_text_to_speech_with_timestamps("v1"),
            "https://gateway.test/eleven/text-to-speech/v1/with-timestamps"
        );
        unsafe { std::env::remove_var("THOTH_ELEVENLABS_BASE_URL") };
    }

    /// The point of this module is that it is the ONLY place a provider host is written. A literal
    /// that creeps back into a call site is invisible to every `THOTH_*_BASE_URL` an operator sets,
    /// so guard it here rather than trusting review to catch the next one.
    #[test]
    fn no_call_site_writes_a_provider_host_literally() {
        const HOSTS: [&str; 9] = [
            "api.groq.com",
            "api.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "api.novita.ai",
            "openrouter.ai",
            "api.together.xyz",
            "api.fireworks.ai",
            "api.elevenlabs.io",
        ];
        // Walk every crate in the workspace, not just this one.
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut offenders = Vec::new();
        let mut stack = vec![crates];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n == "target") {
                        continue;
                    }
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && path.file_name().is_some_and(|n| n != "endpoints.rs")
                    && let Ok(source) = std::fs::read_to_string(&path)
                {
                    for (index, line) in source.lines().enumerate() {
                        // Doc comments and prose may name a host (sign-up pages, API references).
                        if line.trim_start().starts_with("//") {
                            continue;
                        }
                        if HOSTS.iter().any(|host| line.contains(host)) {
                            offenders.push(format!("{}:{}", path.display(), index + 1));
                        }
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "provider hosts belong in endpoints.rs, not in call sites: {offenders:?}"
        );
    }

    #[test]
    fn blank_override_is_treated_as_unset() {
        // SAFETY: single-threaded test; a dedicated variable no other test reads.
        unsafe { std::env::set_var("THOTH_TOGETHER_BASE_URL", "   ") };
        assert_eq!(together(), TOGETHER_BASE_URL);
        unsafe { std::env::remove_var("THOTH_TOGETHER_BASE_URL") };
    }
}
