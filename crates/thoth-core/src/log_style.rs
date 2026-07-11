use crate::brand;
use std::fmt;
use tracing::Event;
use tracing::Subscriber;
use tracing_subscriber::fmt::{format, FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

/// Feather-spine event formatter: every log line is a thin spine + a level
/// glyph. Stage headers (the heavy `█` block) live in [`crate::util::progress`].
///
///   ▏ · message        (info)
///   ▏ ⚠ message        (warn, amber)
///   ▏ ✗ message        (error, red)
pub struct ThothFormatter;

impl<S, N> FormatEvent<S, N> for ThothFormatter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: format::Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let p = brand::p();
        let level = *event.metadata().level();

        let (glyph, gcolor) = match level {
            tracing::Level::ERROR => (brand::ERR, p.red),
            tracing::Level::WARN => (brand::WARN, p.amber),
            tracing::Level::INFO => (brand::DOT, p.cyan),
            tracing::Level::DEBUG => (brand::DOT, p.dim),
            tracing::Level::TRACE => (brand::DOT, p.dim),
        };

        // spine + glyph — 2-space margin matches the banner / brand::field()
        write!(
            writer,
            "  {}{}{} {}{}{} ",
            p.violet, brand::SPINE, p.reset, gcolor, glyph, p.reset
        )?;

        // tint the whole message for warn/error so it stands out
        let tint = matches!(level, tracing::Level::WARN | tracing::Level::ERROR);
        if tint {
            write!(writer, "{}", gcolor)?;
        }
        ctx.field_format().format_fields(writer.by_ref(), event)?;
        if tint {
            write!(writer, "{}", p.reset)?;
        }

        writeln!(writer)
    }
}
