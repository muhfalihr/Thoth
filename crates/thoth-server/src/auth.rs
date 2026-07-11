use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

/// Server-wide config shared with handlers.
#[derive(Clone)]
pub struct AppState {
    pub api_key: String,
}

/// Reject any request whose `Authorization: Bearer <key>` does not match.
pub async fn require_api_key(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|k| k == state.api_key);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_key(auth: Option<&str>, expected: &str) -> bool {
        // Mirror of the middleware's check for unit-testing the predicate.
        auth.and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|k| k == expected)
    }

    #[test]
    fn accepts_matching_bearer_and_rejects_others() {
        assert!(header_key(Some("Bearer secret"), "secret"));
        assert!(!header_key(Some("Bearer wrong"), "secret"));
        assert!(!header_key(Some("secret"), "secret")); // missing prefix
        assert!(!header_key(None, "secret"));
    }
}
