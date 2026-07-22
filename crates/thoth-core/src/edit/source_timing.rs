use crate::ingest::content_search::SubtitleBlur;

pub(crate) fn clamp_segment(
    requested_start: f64,
    requested_end: f64,
    source_duration: f64,
    trim_start: f64,
) -> (f64, f64) {
    let source_end = source_duration.max(0.0);
    let clean_start = trim_start.clamp(0.0, source_end);
    let requested_duration = (requested_end - requested_start).max(0.0);
    let start = requested_start.max(clean_start).min(source_end);
    let end = (start + requested_duration).min(source_end);
    (start, end)
}

pub(crate) fn project_blur_regions(
    regions: &[SubtitleBlur],
    segment_start: f64,
    segment_end: f64,
    output_duration: f64,
    loop_source: bool,
) -> Vec<SubtitleBlur> {
    let span = (segment_end - segment_start).max(0.0);
    let output_end = output_duration.max(0.0);
    if span <= f64::EPSILON || output_end <= f64::EPSILON {
        return Vec::new();
    }

    let mut projected = Vec::new();
    for region in regions {
        if region.start == 0.0 && region.end == 0.0 {
            let mut whole = region.clone();
            whole.start = 0.0;
            whole.end = 0.0;
            projected.push(whole);
            continue;
        }

        let source_start = region.start.max(segment_start);
        let source_end = region.end.min(segment_end);
        if source_end <= source_start {
            continue;
        }
        let relative_start = source_start - segment_start;
        let relative_end = source_end - segment_start;
        let repeat_count = if loop_source {
            (output_end / span).ceil() as usize
        } else {
            1
        };
        for repeat in 0..repeat_count {
            let offset = repeat as f64 * span;
            let start = relative_start + offset;
            if start >= output_end {
                break;
            }
            let end = (relative_end + offset).min(output_end);
            if end > start {
                let mut mapped = region.clone();
                mapped.start = start;
                mapped.end = end;
                projected.push(mapped);
            }
        }
    }
    projected
}

pub(crate) fn clean_loop_video_prefix(source_duration: f64, trim_start: f64) -> String {
    format!(
        "select='gte(mod(t\\,{source_duration:.6})\\,{trim_start:.6})',setpts=N/FRAME_RATE/TB"
    )
}

pub(crate) fn clean_loop_audio_prefix(source_duration: f64, trim_start: f64) -> String {
    format!(
        "aselect='gte(mod(t\\,{source_duration:.6})\\,{trim_start:.6})',asetpts=N/SR/TB"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::content_search::SubtitleBlur;

    fn blur(start: f64, end: f64) -> SubtitleBlur {
        SubtitleBlur { x: 0.1, y: 0.7, w: 0.8, h: 0.1, start, end }
    }

    #[test]
    fn clamps_segment_after_intro() {
        assert_eq!(clamp_segment(0.0, 8.0, 26.0, 4.0), (4.0, 12.0));
    }

    #[test]
    fn projects_after_trim() {
        let got = project_blur_regions(&[blur(5.0, 8.0)], 4.0, 26.0, 10.0, false);
        assert_eq!((got[0].start, got[0].end), (1.0, 4.0));
    }

    #[test]
    fn repeats_for_clean_loop() {
        let got = project_blur_regions(&[blur(5.0, 8.0)], 4.0, 10.0, 14.0, true);
        let times: Vec<_> = got.iter().map(|region| (region.start, region.end)).collect();
        assert_eq!(times, vec![(1.0, 4.0), (7.0, 10.0), (13.0, 14.0)]);
    }

    #[test]
    fn clean_loop_filters_remove_every_intro() {
        assert!(clean_loop_video_prefix(26.935, 4.0)
            .contains("gte(mod(t\\,26.935000)\\,4.000000)"));
        assert!(clean_loop_audio_prefix(26.935, 4.0)
            .contains("aselect='gte(mod(t\\,26.935000)\\,4.000000)'"));
    }
}
