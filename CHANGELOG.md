# Changelog - CLIPPER

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-05-23

### Added
- **Thumbnail Generation**: Added automatic thumbnail generation using FFmpeg. Thumbnails are captured at the most crucial moments (typically when an overlay appears).
- **Vocab Cache System**: Implemented a database-backed vocabulary cache system using Supabase to improve AI analysis accuracy.
- **YouTube Transcript Support**: The application can now detect and use native YouTube transcripts (JSON3/VTT), significantly reducing Groq/Whisper API costs.
- **Multi-Provider LLM Support**: Integration with Anthropic Claude and Google Gemini APIs.
- **Database Schema Migration**: Added support for the `headline` column and full production metadata in the `viral_moments` (Supabase) table.

### Fixed
- **Overlay Download Reliability**: Fixed a bug where overlay downloads often failed because the duration of the first search result was too long. The logic now explores up to 10 search results.
- **RAG Insert Failure**: Fixed RAG storage failures by aligning the `INSERT` query with the latest database schema.
- **BPE Tokenization Fix**: Fixed merging of sub-word tokens produced by Groq/Whisper.

### Changed
- **Subtitle Styling**: Changed the `CapcutBold` style stroke color from Yellow to **Orange** to improve contrast and readability for white text.
- **yt-dlp Orchestration**: Removed the `--no-playlist` flag in overlay searches to allow downloading videos from search result lists.

## [0.1.0] - 2026-03-15
### Added
- Initial project release of CLIPPER.
- Basic FFmpeg integration for editing.
- Analysis pipeline using Groq (Llama 3).
- Local caching system for video and audio files.
