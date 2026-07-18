use std::path::Path;

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeError;

/// Parse one strict HTTP `bytes` range against a known non-empty file length.
///
/// This deliberately accepts neither whitespace nor multi-ranges: callers map
/// every malformed or unsatisfiable request to one uniform 416 response.
pub fn parse_single_range(value: &str, len: u64) -> Result<ByteRange, RangeError> {
    if len == 0 {
        return Err(RangeError);
    }

    let spec = value.strip_prefix("bytes=").ok_or(RangeError)?;
    if spec.is_empty() || spec.contains(',') {
        return Err(RangeError);
    }

    let (start, end) = spec.split_once('-').ok_or(RangeError)?;
    if end.contains('-') {
        return Err(RangeError);
    }

    if start.is_empty() {
        let suffix = parse_decimal(end)?;
        if suffix == 0 {
            return Err(RangeError);
        }
        return Ok(ByteRange {
            start: len.saturating_sub(suffix),
            end: len - 1,
        });
    }

    let start = parse_decimal(start)?;
    if start >= len {
        return Err(RangeError);
    }

    let end = if end.is_empty() {
        len - 1
    } else {
        parse_decimal(end)?
    };

    if end < start || end >= len {
        return Err(RangeError);
    }

    Ok(ByteRange { start, end })
}

fn parse_decimal(value: &str) -> Result<u64, RangeError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RangeError);
    }
    value.parse().map_err(|_| RangeError)
}

/// Stream one regular file, optionally as a single HTTP byte range.
///
/// The caller supplies an already-authorized, already traversal-validated
/// `path`; this responder only owns file semantics and representation headers.
pub async fn serve_file(
    method: &Method,
    headers: &HeaderMap,
    path: &Path,
    content_type: &'static str,
) -> Result<Response, StatusCode> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let metadata = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let len = metadata.len();
    let range = match headers.get(header::RANGE) {
        None => None,
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| parse_single_range(value, len).ok())
        {
            Some(range) => Some(range),
            None => return range_not_satisfiable(len, content_type),
        },
    };

    let (status, content_length) = match range {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.end - range.start + 1),
        None => (StatusCode::OK, len),
    };
    let mut response = response_builder(status, content_type, content_length);
    if let Some(range) = range {
        response = response.header(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", range.start, range.end, len))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        );
    }

    if method == Method::HEAD {
        return response
            .body(Body::empty())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    let body = match range {
        Some(range) => {
            file.seek(SeekFrom::Start(range.start))
                .await
                .map_err(|_| StatusCode::NOT_FOUND)?;
            Body::from_stream(ReaderStream::new(file.take(content_length)))
        }
        None => Body::from_stream(ReaderStream::new(file)),
    };
    response
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn range_not_satisfiable(len: u64, content_type: &'static str) -> Result<Response, StatusCode> {
    response_builder(StatusCode::RANGE_NOT_SATISFIABLE, content_type, 0)
        .header(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes */{len}"))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        )
        .body(Body::empty())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn response_builder(
    status: StatusCode,
    content_type: &'static str,
    content_length: u64,
) -> axum::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(header::ACCEPT_RANGES, "bytes")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::{
        body::to_bytes,
        http::{HeaderMap, Method, StatusCode, header},
    };

    use super::{ByteRange, parse_single_range, serve_file};

    const TEN_BYTES: u64 = 10;

    #[test]
    fn parses_valid_ten_byte_ranges() {
        let cases = [
            ("bytes=0-3", ByteRange { start: 0, end: 3 }),
            ("bytes=4-", ByteRange { start: 4, end: 9 }),
            ("bytes=-4", ByteRange { start: 6, end: 9 }),
            ("bytes=-99", ByteRange { start: 0, end: 9 }),
            ("bytes=9-9", ByteRange { start: 9, end: 9 }),
        ];

        for (value, expected) in cases {
            assert_eq!(
                parse_single_range(value, TEN_BYTES),
                Ok(expected),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_invalid_or_ambiguous_ten_byte_ranges() {
        let cases = [
            "items=0-3",
            "bytes=",
            "bytes=0-1,4-5",
            "bytes=a-3",
            "bytes=0-b",
            "bytes= 0-3",
            " bytes=0-3",
            "bytes=0-3 ",
            "bytes =0-3",
            "bytes=10-",
            "bytes=10-10",
            "bytes=0-10",
            "bytes=8-2",
            "bytes=-0",
        ];

        for value in cases {
            assert!(parse_single_range(value, TEN_BYTES).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_every_range_for_zero_byte_files() {
        for value in ["bytes=0-0", "bytes=0-", "bytes=-1"] {
            assert!(parse_single_range(value, 0).is_err(), "{value}");
        }
    }

    fn write_file(dir: &Path, name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    async fn body(response: axum::response::Response) -> Vec<u8> {
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec()
    }

    fn range_headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, value.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn serves_full_get_and_head_with_representation_headers() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "artifact.txt", b"0123456789");

        let get = serve_file(&Method::GET, &HeaderMap::new(), &path, "text/plain")
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(get.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(get.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(get.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(body(get).await, b"0123456789");

        let head = serve_file(&Method::HEAD, &HeaderMap::new(), &path, "text/plain")
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(head.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(body(head).await.is_empty());
    }

    #[tokio::test]
    async fn serves_prefix_suffix_and_open_ended_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "artifact.txt", b"0123456789");

        for (range, expected_range, expected_body) in [
            ("bytes=0-3", "bytes 0-3/10", b"0123".as_slice()),
            ("bytes=-4", "bytes 6-9/10", b"6789".as_slice()),
            ("bytes=4-", "bytes 4-9/10", b"456789".as_slice()),
        ] {
            let response = serve_file(&Method::GET, &range_headers(range), &path, "text/plain")
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                expected_range,
                "{range}"
            );
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                expected_body.len().to_string(),
                "{range}"
            );
            assert_eq!(body(response).await, expected_body, "{range}");
        }
    }

    #[tokio::test]
    async fn returns_empty_416_for_bad_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "artifact.txt", b"0123456789");

        for range in ["bytes=8-2", "bytes=10-", "bytes=0-1,4-5"] {
            let response = serve_file(&Method::GET, &range_headers(range), &path, "text/plain")
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                "bytes */10",
                "{range}"
            );
            assert!(body(response).await.is_empty(), "{range}");
        }
    }

    #[tokio::test]
    async fn serves_zero_byte_files_but_rejects_their_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "empty.txt", b"");

        for method in [Method::GET, Method::HEAD] {
            let response = serve_file(&method, &HeaderMap::new(), &path, "text/plain")
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
            assert!(body(response).await.is_empty());
        }

        let response = serve_file(
            &Method::GET,
            &range_headers("bytes=0-0"),
            &path,
            "text/plain",
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");
        assert!(body(response).await.is_empty());
    }

    #[tokio::test]
    async fn rejects_missing_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();

        assert!(matches!(
            serve_file(
                &Method::GET,
                &HeaderMap::new(),
                &dir.path().join("missing.txt"),
                "text/plain",
            )
            .await,
            Err(StatusCode::NOT_FOUND)
        ));
        assert!(matches!(
            serve_file(&Method::GET, &HeaderMap::new(), dir.path(), "text/plain").await,
            Err(StatusCode::NOT_FOUND)
        ));
    }
}
