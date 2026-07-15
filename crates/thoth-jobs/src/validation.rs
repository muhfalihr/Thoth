pub const PROTECTED_EXTRA_FLAGS: &[&str] = &["--output-dir", "--job-id", "--content"];

pub const SCALAR_PARAM_FLAGS: &[(&str, &str)] = &[
    ("provider", "--provider"),
    ("model", "--model"),
    ("max_clips", "--max-clips"),
    ("layout", "--layout"),
    ("language", "--language"),
    ("clip_style", "--clip-style"),
    ("style_profile", "--style-profile"),
    ("social", "--social"),
    ("bgm", "--bgm"),
    ("bgm_volume", "--bgm-volume"),
    ("sfx_intro", "--sfx-intro"),
    ("headline_dur", "--headline-dur"),
];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct JobValidationError {
    pub field: String,
    pub code: &'static str,
    pub message: String,
}

pub fn scalar_param_flag(key: &str) -> Option<&'static str> {
    SCALAR_PARAM_FLAGS
        .iter()
        .find_map(|(candidate, flag)| (*candidate == key).then_some(*flag))
}

pub fn validate_job_spec(spec: &JobSpec) -> Result<(), JobValidationError> {
    if spec.command != "run" {
        return Err(validation_error(
            "command",
            "unsupported_command",
            "command must be `run`",
        ));
    }

    match (spec.url.as_deref(), spec.content_set.as_deref()) {
        (Some(url), None) if is_non_blank(url) => {}
        (None, Some(content_set)) if is_non_blank(content_set) => {}
        _ => {
            return Err(validation_error(
                "source",
                "invalid_source",
                "exactly one non-blank `url` or `content_set` is required",
            ));
        }
    }

    if spec.params.is_null() {
        return Ok(());
    }
    let Some(params) = spec.params.as_object() else {
        return Err(validation_error(
            "params",
            "invalid_params",
            "params must be null or an object",
        ));
    };

    let mut keys: Vec<&str> = params.keys().map(String::as_str).collect();
    keys.sort_unstable();
    for key in keys {
        if !is_known_parameter(key) {
            return Err(validation_error(
                format!("params.{key}"),
                "unknown_parameter",
                format!("unknown job parameter `{key}`"),
            ));
        }
        let value = &params[key];
        match key {
            "provider" => validate_enum(
                key,
                value,
                &[
                    "groq",
                    "openai",
                    "claude",
                    "gemini",
                    "vllm",
                    "ollama",
                    "novita",
                    "together",
                    "fireworks",
                ],
            )?,
            "model" => validate_enum(key, value, &["tiny", "base", "small", "medium", "large-v3"])?,
            "layout" => validate_enum(key, value, &["vertical", "horizontal", "square"])?,
            "clip_style" => {
                validate_enum(key, value, &["fade", "flash", "zoom", "smooth", "none"])?;
            }
            "language" | "style_profile" | "social" | "bgm" | "sfx_intro" => {
                validate_non_blank_string(key, value)?;
            }
            "max_clips" => validate_max_clips(value)?,
            "bgm_volume" => validate_bgm_volume(value)?,
            "headline_dur" => validate_headline_duration(value)?,
            "keywords" | "extra_args" => validate_string_array(key, value)?,
            _ => unreachable!("known parameter was checked above"),
        }
    }

    validate_extra_args(params)
}

fn is_known_parameter(key: &str) -> bool {
    scalar_param_flag(key).is_some() || matches!(key, "keywords" | "extra_args")
}

fn is_non_blank(value: &str) -> bool {
    !value.trim().is_empty()
}

fn validate_non_blank_string<'a>(
    key: &str,
    value: &'a serde_json::Value,
) -> Result<&'a str, JobValidationError> {
    match value.as_str() {
        Some(candidate) if is_non_blank(candidate) => Ok(candidate),
        _ => Err(invalid_parameter(key, "must be a non-blank string")),
    }
}

fn validate_enum(
    key: &str,
    value: &serde_json::Value,
    accepted: &[&str],
) -> Result<(), JobValidationError> {
    let candidate = validate_non_blank_string(key, value)?;
    if accepted.contains(&candidate) {
        Ok(())
    } else {
        Err(invalid_parameter(
            key,
            format!("must be one of: {}", accepted.join(", ")),
        ))
    }
}

fn validate_max_clips(value: &serde_json::Value) -> Result<(), JobValidationError> {
    match value.as_u64() {
        Some(candidate) if candidate >= 1 && u128::from(candidate) <= usize::MAX as u128 => Ok(()),
        _ => Err(invalid_parameter(
            "max_clips",
            "must be an integer greater than or equal to 1 representable as usize",
        )),
    }
}

fn validate_bgm_volume(value: &serde_json::Value) -> Result<(), JobValidationError> {
    match value.as_f64() {
        Some(candidate) if candidate.is_finite() && (0.0..=1.0).contains(&candidate) => Ok(()),
        _ => Err(invalid_parameter(
            "bgm_volume",
            "must be a finite number between 0.0 and 1.0 inclusive",
        )),
    }
}

fn validate_headline_duration(value: &serde_json::Value) -> Result<(), JobValidationError> {
    match value.as_f64() {
        Some(candidate) if candidate.is_finite() && candidate > 0.0 => Ok(()),
        _ => Err(invalid_parameter(
            "headline_dur",
            "must be a finite positive number",
        )),
    }
}

fn validate_string_array(key: &str, value: &serde_json::Value) -> Result<(), JobValidationError> {
    match value.as_array() {
        Some(values)
            if values
                .iter()
                .all(|item| item.as_str().is_some_and(is_non_blank)) =>
        {
            Ok(())
        }
        _ => Err(invalid_parameter(
            key,
            "must be an array of non-blank strings",
        )),
    }
}

fn validate_extra_args(
    params: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), JobValidationError> {
    let Some(extra_args) = params
        .get("extra_args")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(());
    };

    for (index, token) in extra_args
        .iter()
        .filter_map(serde_json::Value::as_str)
        .enumerate()
    {
        if token.starts_with("-o")
            || PROTECTED_EXTRA_FLAGS.iter().any(|flag| {
                token == *flag
                    || token
                        .strip_prefix(*flag)
                        .is_some_and(|suffix| suffix.starts_with('='))
            })
        {
            return Err(validation_error(
                format!("params.extra_args[{index}]"),
                "protected_argument",
                format!("extra argument `{token}` overrides a protected job argument"),
            ));
        }
        if matches!(token, "-" | "--") || !token.starts_with('-') {
            return Err(validation_error(
                format!("params.extra_args[{index}]"),
                "protected_argument",
                format!("positional input `{token}` is not allowed in extra_args"),
            ));
        }
    }
    Ok(())
}

fn invalid_parameter(key: &str, message: impl Into<String>) -> JobValidationError {
    validation_error(format!("params.{key}"), "invalid_parameter", message)
}

fn validation_error(
    field: impl Into<String>,
    code: &'static str,
    message: impl Into<String>,
) -> JobValidationError {
    JobValidationError {
        field: field.into(),
        code,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{JobValidationError, scalar_param_flag, validate_job_spec};
    use crate::{JobSpec, PROTECTED_EXTRA_FLAGS, SCALAR_PARAM_FLAGS};
    use serde_json::{Number, Value, json};

    fn spec(url: Option<&str>, content_set: Option<&str>, params: Value) -> JobSpec {
        JobSpec {
            command: "run".to_owned(),
            url: url.map(str::to_owned),
            content_set: content_set.map(str::to_owned),
            params,
        }
    }

    fn assert_error(spec: &JobSpec, field: &str, code: &str) {
        let error = validate_job_spec(spec).expect_err("job specification must be rejected");
        assert_eq!(error.field, field);
        assert_eq!(error.code, code);
        assert!(!error.message.is_empty());
    }

    #[test]
    fn exposes_stable_contract_definitions() {
        assert_eq!(
            PROTECTED_EXTRA_FLAGS,
            &["--output-dir", "--job-id", "--content"]
        );
        assert_eq!(
            SCALAR_PARAM_FLAGS,
            &[
                ("provider", "--provider"),
                ("model", "--model"),
                ("max_clips", "--max-clips"),
                ("layout", "--layout"),
                ("language", "--language"),
                ("clip_style", "--clip-style"),
                ("style_profile", "--style-profile"),
                ("social", "--social"),
                ("bgm", "--bgm"),
                ("bgm_volume", "--bgm-volume"),
                ("sfx_intro", "--sfx-intro"),
                ("headline_dur", "--headline-dur"),
            ]
        );
        for (key, flag) in SCALAR_PARAM_FLAGS {
            assert_eq!(scalar_param_flag(key), Some(*flag));
        }
        assert_eq!(scalar_param_flag("keywords"), None);

        let error = JobValidationError {
            field: "params.provider".to_owned(),
            code: "invalid_parameter",
            message: "unsupported provider".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(error).expect("validation error must serialize"),
            serde_json::json!({
                "field": "params.provider",
                "code": "invalid_parameter",
                "message": "unsupported provider"
            })
        );
    }

    #[test]
    fn requires_run_command() {
        let mut request = spec(Some("https://x.test"), None, json!(null));
        request.command = "analyze".to_owned();

        assert_error(&request, "command", "unsupported_command");
    }

    #[test]
    fn requires_exactly_one_non_blank_source() {
        for (url, content_set) in [
            (None, None),
            (Some("https://x.test"), Some("set.json")),
            (Some("   "), None),
            (None, Some("\t")),
        ] {
            let request = spec(url, content_set, json!(null));
            assert_error(&request, "source", "invalid_source");
        }
    }

    #[test]
    fn params_must_be_null_or_an_object() {
        let null_params = spec(Some("https://x.test"), None, json!(null));
        assert_eq!(validate_job_spec(&null_params), Ok(()));

        for params in [json!(true), json!("provider"), json!([]), json!(3)] {
            let request = spec(Some("https://x.test"), None, params);
            assert_error(&request, "params", "invalid_params");
        }
    }

    #[test]
    fn rejects_unknown_parameter_keys_in_sorted_order() {
        let empty = spec(Some("https://x.test"), None, json!({}));
        assert_eq!(validate_job_spec(&empty), Ok(()));

        let request = spec(
            Some("https://x.test"),
            None,
            json!({ "z_unknown": true, "a_unknown": true }),
        );
        assert_error(&request, "params.a_unknown", "unknown_parameter");
    }

    #[test]
    fn rejects_blank_scalar_strings() {
        for key in [
            "provider",
            "model",
            "layout",
            "language",
            "clip_style",
            "style_profile",
            "social",
            "bgm",
            "sfx_intro",
        ] {
            let request = spec(Some("https://x.test"), None, json!({ key: "  \t" }));
            assert_error(&request, &format!("params.{key}"), "invalid_parameter");
        }
    }

    #[test]
    fn validates_enum_parameters() {
        for (key, accepted) in [
            (
                "provider",
                &[
                    "groq",
                    "openai",
                    "claude",
                    "gemini",
                    "vllm",
                    "ollama",
                    "novita",
                    "together",
                    "fireworks",
                ][..],
            ),
            ("model", &["tiny", "base", "small", "medium", "large-v3"]),
            ("layout", &["vertical", "horizontal", "square"]),
            ("clip_style", &["fade", "flash", "zoom", "smooth", "none"]),
        ] {
            for value in accepted {
                let request = spec(Some("https://x.test"), None, json!({ key: value }));
                assert_eq!(validate_job_spec(&request), Ok(()), "{key}={value}");
            }

            let request = spec(Some("https://x.test"), None, json!({ key: "unsupported" }));
            assert_error(&request, &format!("params.{key}"), "invalid_parameter");
        }
    }

    #[test]
    fn max_clips_must_be_a_positive_usize_integer() {
        for value in [json!(0), json!(-1), json!(1.5), json!("3"), json!(null)] {
            let request = spec(Some("https://x.test"), None, json!({ "max_clips": value }));
            assert_error(&request, "params.max_clips", "invalid_parameter");
        }

        let too_large = if usize::BITS < 64 {
            Value::from(u64::MAX)
        } else {
            Value::Number(
                Number::from_f64((usize::MAX as f64) * 2.0).expect("twice usize::MAX is finite"),
            )
        };
        let request = spec(
            Some("https://x.test"),
            None,
            json!({ "max_clips": too_large }),
        );
        assert_error(&request, "params.max_clips", "invalid_parameter");

        for value in [json!(1), json!(usize::MAX)] {
            let request = spec(Some("https://x.test"), None, json!({ "max_clips": value }));
            assert_eq!(validate_job_spec(&request), Ok(()));
        }
    }

    #[test]
    fn bgm_volume_must_be_finite_and_within_unit_interval() {
        for value in [json!(-0.01), json!(1.01), json!("0.5"), json!(null)] {
            let request = spec(Some("https://x.test"), None, json!({ "bgm_volume": value }));
            assert_error(&request, "params.bgm_volume", "invalid_parameter");
        }

        for value in [json!(0.0), json!(0.25), json!(1.0)] {
            let request = spec(Some("https://x.test"), None, json!({ "bgm_volume": value }));
            assert_eq!(validate_job_spec(&request), Ok(()));
        }
    }

    #[test]
    fn headline_duration_must_be_finite_and_positive() {
        for value in [json!(0), json!(-0.1), json!("4"), json!(null)] {
            let request = spec(
                Some("https://x.test"),
                None,
                json!({ "headline_dur": value }),
            );
            assert_error(&request, "params.headline_dur", "invalid_parameter");
        }

        for value in [json!(0.1), json!(4), json!(f64::MAX)] {
            let request = spec(
                Some("https://x.test"),
                None,
                json!({ "headline_dur": value }),
            );
            assert_eq!(validate_job_spec(&request), Ok(()));
        }
    }

    #[test]
    fn keywords_must_be_an_array_of_non_blank_strings() {
        for value in [json!("news"), json!(["news", ""]), json!(["news", 3])] {
            let request = spec(Some("https://x.test"), None, json!({ "keywords": value }));
            assert_error(&request, "params.keywords", "invalid_parameter");
        }

        for value in [json!([]), json!(["news", "AI"])] {
            let request = spec(Some("https://x.test"), None, json!({ "keywords": value }));
            assert_eq!(validate_job_spec(&request), Ok(()));
        }
    }

    #[test]
    fn extra_args_must_be_an_array_of_non_blank_strings() {
        for value in [json!("--flag"), json!(["--flag", ""]), json!([3])] {
            let request = spec(Some("https://x.test"), None, json!({ "extra_args": value }));
            assert_error(&request, "params.extra_args", "invalid_parameter");
        }

        for value in [json!([]), json!(["--social-icon=x.png", "--no-overlay"])] {
            let request = spec(Some("https://x.test"), None, json!({ "extra_args": value }));
            assert_eq!(validate_job_spec(&request), Ok(()));
        }
    }

    #[test]
    fn accepts_url_and_content_set_requests_with_every_parameter() {
        let params = json!({
            "provider": "novita",
            "model": "large-v3",
            "max_clips": 3,
            "layout": "vertical",
            "language": "id",
            "clip_style": "smooth",
            "style_profile": "tiktok_id_2025",
            "social": "@thoth",
            "bgm": "music.mp3",
            "bgm_volume": 0.2,
            "sfx_intro": "intro.wav",
            "headline_dur": 4.0,
            "keywords": ["prabowo", "AI"],
            "extra_args": ["--social-icon=x.png", "--no-overlay"]
        });

        assert_eq!(
            validate_job_spec(&spec(Some("https://x.test"), None, params.clone())),
            Ok(())
        );
        assert_eq!(
            validate_job_spec(&spec(None, Some("set.json"), params)),
            Ok(())
        );
    }

    #[test]
    fn rejects_protected_long_extra_args_in_both_spellings() {
        for args in [
            vec!["--output-dir", "elsewhere"],
            vec!["--output-dir=elsewhere"],
            vec!["--job-id", "other"],
            vec!["--job-id=other"],
            vec!["--content", "other.json"],
            vec!["--content=other.json"],
        ] {
            let request = spec(Some("https://x.test"), None, json!({ "extra_args": args }));
            assert_eq!(
                validate_job_spec(&request)
                    .expect_err("protected long flag must be rejected")
                    .code,
                "protected_argument"
            );
        }
    }

    #[test]
    fn rejects_positional_extra_args() {
        let request = spec(
            Some("https://x.test"),
            None,
            json!({ "extra_args": ["--safe", "positional-source.mp4"] }),
        );

        let error = validate_job_spec(&request).expect_err("positional input must be rejected");
        assert_eq!(error.field, "params.extra_args[1]");
        assert_eq!(error.code, "protected_argument");
    }

    #[test]
    fn rejects_option_terminator_and_lone_dash() {
        for token in ["--", "-"] {
            let request = spec(
                Some("https://x.test"),
                None,
                json!({ "extra_args": [token] }),
            );
            assert_eq!(
                validate_job_spec(&request)
                    .expect_err("dash-only token must be rejected")
                    .code,
                "protected_argument"
            );
        }
    }

    #[test]
    fn rejects_output_dir_short_alias_in_separate_and_attached_forms() {
        for args in [
            vec!["-o", "elsewhere"],
            vec!["-oelsewhere"],
            vec!["-o=elsewhere"],
        ] {
            let request = spec(Some("https://x.test"), None, json!({ "extra_args": args }));
            assert_eq!(
                validate_job_spec(&request)
                    .expect_err("output-dir short alias must be rejected")
                    .code,
                "protected_argument"
            );
        }
    }
}
use crate::JobSpec;
