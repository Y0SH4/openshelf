//! Translating selected text through a LibreTranslate server
//! (`OPENSHELF_TRANSLATE_URL`). Without one, the reader falls back to opening
//! Google Translate in a new tab, so only `enabled` is reported here.

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::routes::{ApiError, AppState};

/// Longest selection that can be translated at once
pub const MAX_TRANSLATE_CHARS: usize = 5000;
/// LibreTranslate on a small home server can take a while for long text
const TIMEOUT: Duration = Duration::from_secs(45);

pub struct Translator {
    client: reqwest::Client,
    url: String,
    api_key: Option<String>,
}

impl Translator {
    /// `url` is the LibreTranslate base URL, e.g. `http://libretranslate:5000`.
    pub fn new(url: &str, api_key: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("HTTP client");
        Translator {
            client,
            url: format!("{}/translate", url.trim_end_matches('/')),
            api_key,
        }
    }
}

#[derive(Serialize)]
pub struct TranslateStatus {
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct TranslatePayload {
    pub text: String,
    /// Language code, e.g. "id"
    pub target: String,
    /// Language code, or omitted to detect it
    pub source: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Translation {
    pub translated: String,
    /// Detected language of the text, when `source` was omitted
    pub source: Option<String>,
}

#[derive(Serialize)]
struct LibreRequest<'a> {
    q: &'a str,
    source: &'a str,
    target: &'a str,
    format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<&'a str>,
}

#[derive(Deserialize)]
struct LibreResponse {
    #[serde(rename = "translatedText")]
    translated_text: Option<String>,
    #[serde(rename = "detectedLanguage")]
    detected_language: Option<DetectedLanguage>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct DetectedLanguage {
    language: String,
}

/// "id", "en", "pt-BR", "zh-Hans"
fn is_language_code(code: &str) -> bool {
    let mut parts = code.splitn(2, '-');
    let base = parts.next().unwrap_or("");
    let region_ok = parts
        .next()
        .is_none_or(|r| (2..=4).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric()));
    (2..=3).contains(&base.len()) && base.chars().all(|c| c.is_ascii_lowercase()) && region_ok
}

// GET /api/translate
pub async fn status(State(state): State<AppState>) -> Json<TranslateStatus> {
    Json(TranslateStatus {
        enabled: state.translator.is_some(),
    })
}

// POST /api/translate
pub async fn translate(
    State(state): State<AppState>,
    Json(payload): Json<TranslatePayload>,
) -> Result<Json<Translation>, ApiError> {
    let Some(translator) = state.translator.as_deref() else {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "Translation isn't set up on this server (OPENSHELF_TRANSLATE_URL).".into(),
        ));
    };
    let text = payload.text.trim();
    if text.is_empty() {
        return Err(ApiError::bad_request("Nothing to translate"));
    }
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        return Err(ApiError::bad_request(format!(
            "Select less text (at most {MAX_TRANSLATE_CHARS} characters at a time)"
        )));
    }
    let source = payload.source.as_deref().unwrap_or("auto");
    if !is_language_code(&payload.target) || (source != "auto" && !is_language_code(source)) {
        return Err(ApiError::bad_request("Unknown language"));
    }

    let request = LibreRequest {
        q: text,
        source,
        target: &payload.target,
        format: "text",
        api_key: translator.api_key.as_deref(),
    };
    let response = translator
        .client
        .post(&translator.url)
        .json(&request)
        .send()
        .await
        .map_err(|e| translate_error("Can't reach the translation server", e))?;
    let status = response.status();
    let body: LibreResponse = response
        .json()
        .await
        .map_err(|e| translate_error("Unexpected reply from the translation server", e))?;

    match body.translated_text {
        Some(translated) if status.is_success() => Ok(Json(Translation {
            translated,
            source: body.detected_language.map(|d| d.language),
        })),
        _ => {
            let reason = body.error.unwrap_or_else(|| status.to_string());
            eprintln!("⚠️  Translation failed: {reason}");
            Err(ApiError(
                StatusCode::BAD_GATEWAY,
                format!("Translation failed: {reason}"),
            ))
        }
    }
}

fn translate_error(msg: &str, err: reqwest::Error) -> ApiError {
    eprintln!("⚠️  {msg}: {err}");
    let status = if err.is_timeout() {
        StatusCode::GATEWAY_TIMEOUT
    } else {
        StatusCode::BAD_GATEWAY
    };
    ApiError(status, format!("{msg}. Try again in a moment."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes() {
        for ok in ["id", "en", "pt-BR", "zh-Hans", "fil"] {
            assert!(is_language_code(ok), "{ok}");
        }
        for bad in [
            "",
            "ID",
            "e",
            "english",
            "en-",
            "en-toolongx",
            "../x",
            "en?x=1",
        ] {
            assert!(!is_language_code(bad), "{bad}");
        }
    }
}
