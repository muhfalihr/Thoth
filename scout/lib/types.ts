// types.ts — kontrak data hand-off scout → Thoth (mirror dari struct Rust
// src/ingest/content_search.rs: ContentSet/MainVideo/ContentResult/CommentInfo).
// Rust memakai #[serde(default)] TANPA deny_unknown_fields → field baru di sini
// aman (forward-compat); field yang tak dikenal Rust diabaikan.

export interface ProfileInfo {
  username?: string;
  display_name?: string;
  avatar_path?: string;
  [k: string]: any;
}

export interface MainVideo {
  url: string;
  title?: string;
  /** Caption/deskripsi asli postingan — WAJIB diisi scout (grounding narasi saat audio kosong). */
  description?: string;
  platform?: string;
  is_video?: boolean;
  /** Crop kartu postingan (PNG absolut) untuk main non-video. */
  image_path?: string;
  profile?: ProfileInfo;
  [k: string]: any;
}

export interface ContentResult {
  url: string;
  title?: string;
  platform?: string;
  is_video?: boolean;
  /** Keyword penemu footage ini (dari title+description+komentar main). */
  query?: string;
  /** Crop kartu postingan (PNG absolut) untuk footage non-video. */
  image_path?: string;
  [k: string]: any;
}

export interface CommentInfo {
  text: string;
  author?: string;
  likes?: number;
  /** Crop PNG komentar (path absolut, output/crops/comment_*.png). */
  image_path?: string;
  /** 1 kalimat makna tersirat + nada (diisi enrich_context). */
  context?: string;
  [k: string]: any;
}

export interface Reference {
  term: string;
  kind: string;
  summary: string;
  as_of_date?: string;
  source_url?: string;
}
export interface Discourse {
  audience_stance: string;
  themes: string[];
  narration_guidance: string;
}
export interface Figure {
  name: string;
  type?: string;
  [k: string]: any;
}

export interface ContentSet {
  main: MainVideo;
  footage: ContentResult[];
  comments: CommentInfo[];
  figures?: Figure[];
  references?: Reference[];
  discourse?: Discourse;
  [k: string]: any;
}
