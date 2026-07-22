use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

use crate::{schwab, schwab::Schwab, storage, AppError};

const OAUTH_WINDOW: &str = "schwab-oauth";

pub async fn begin(app: AppHandle, api: Schwab) -> Result<(), AppError> {
    let (client_id, _) = storage::schwab_client()?.ok_or(AppError::AuthenticationRequired)?;
    if let Some(existing) = app.get_webview_window(OAUTH_WINDOW) {
        let _ = existing.set_focus();
        return Err(AppError::Validation(
            "A Schwab authorization is already in progress".into(),
        ));
    }

    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let expected_state = URL_SAFE_NO_PAD.encode(random);
    let started_at = chrono::Utc::now().timestamp_millis();
    let mut authorize_url = url::Url::parse(schwab::AUTHORIZE_URL)?;
    authorize_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", schwab::REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("state", &expected_state);

    let (sender, receiver) = oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let navigation_sender = sender.clone();
    let oauth_window =
        WebviewWindowBuilder::new(&app, OAUTH_WINDOW, WebviewUrl::External(authorize_url))
            .title("Connect Schwab")
            .inner_size(760.0, 860.0)
            .min_inner_size(560.0, 680.0)
            .center()
            .incognito(true)
            .on_navigation(move |url| {
                if is_callback(url) {
                    if let Ok(mut slot) = navigation_sender.lock() {
                        if let Some(sender) = slot.take() {
                            let _ = sender.send(Ok(url.to_string()));
                        }
                    }
                    false
                } else {
                    url.scheme() == "https"
                }
            })
            .build()
            .map_err(|error| AppError::Api(format!("Unable to open Schwab login: {error}")))?;

    let close_sender = sender.clone();
    oauth_window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            if let Ok(mut slot) = close_sender.lock() {
                if let Some(sender) = slot.take() {
                    let _ = sender.send(Err(
                        "Schwab login was closed before authorization completed".into(),
                    ));
                }
            }
        }
    });

    let callback = match tokio::time::timeout(Duration::from_secs(300), receiver).await {
        Ok(Ok(result)) => result.map_err(AppError::Api),
        Ok(Err(_)) => Err(AppError::Api(
            "Schwab login ended before the callback was received".into(),
        )),
        Err(_) => Err(AppError::Api(
            "Schwab authorization timed out after five minutes".into(),
        )),
    };
    let _ = oauth_window.close();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }

    let callback = callback?;
    complete_callback(&api, &callback, &expected_state, started_at).await
}

fn is_callback(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(8182)
        && url.path() == "/callback"
}

async fn complete_callback(
    api: &Schwab,
    value: &str,
    expected_state: &str,
    started_at: i64,
) -> Result<(), AppError> {
    let code = validate_callback(
        value,
        expected_state,
        started_at,
        chrono::Utc::now().timestamp_millis(),
    )?;
    api.exchange_code(&code).await
}

fn validate_callback(
    value: &str,
    expected_state: &str,
    started_at: i64,
    now: i64,
) -> Result<String, AppError> {
    let callback = url::Url::parse(value)
        .map_err(|_| AppError::Api("Schwab returned an invalid callback URL".into()))?;
    if !is_callback(&callback) {
        return Err(AppError::Api(
            "Schwab returned an unexpected callback URL".into(),
        ));
    }
    if now.saturating_sub(started_at) > 300_000 {
        return Err(AppError::Api(
            "The Schwab authorization request expired".into(),
        ));
    }
    let query: HashMap<_, _> = callback.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(expected_state) {
        return Err(AppError::Api("OAuth state validation failed".into()));
    }
    if let Some(error) = query.get("error") {
        return Err(AppError::Api(format!(
            "Schwab authorization was denied: {}",
            query.get("error_description").unwrap_or(error)
        )));
    }
    let code = query
        .get("code")
        .ok_or_else(|| AppError::Api("Schwab callback omitted the authorization code".into()))?;
    Ok(code.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intercepts_only_the_registered_callback() {
        assert!(is_callback(
            &url::Url::parse("https://127.0.0.1:8182/callback?code=x").unwrap()
        ));
        assert!(!is_callback(
            &url::Url::parse("http://127.0.0.1:8182/callback?code=x").unwrap()
        ));
        assert!(!is_callback(
            &url::Url::parse("https://127.0.0.1:443/callback?code=x").unwrap()
        ));
        assert!(!is_callback(
            &url::Url::parse("https://127.0.0.1:8182/other?code=x").unwrap()
        ));
    }

    #[test]
    fn validates_state_and_expiration_before_returning_code() {
        assert_eq!(
            validate_callback(
                "https://127.0.0.1:8182/callback?code=abc&state=expected",
                "expected",
                1_000,
                2_000,
            )
            .unwrap(),
            "abc"
        );
        assert!(validate_callback(
            "https://127.0.0.1:8182/callback?code=abc&state=wrong",
            "expected",
            1_000,
            2_000,
        )
        .is_err());
        assert!(validate_callback(
            "https://127.0.0.1:8182/callback?error=access_denied&state=expected",
            "expected",
            1_000,
            2_000,
        )
        .is_err());
        assert!(validate_callback(
            "https://127.0.0.1:8182/callback?code=abc&state=expected",
            "expected",
            1_000,
            301_001,
        )
        .is_err());
    }
}
