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

#[cfg(test)]
mod tests {
    use super::{parse_single_range, ByteRange};

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
            assert_eq!(parse_single_range(value, TEN_BYTES), Ok(expected), "{value}");
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
}
