// types.ts — kontrak data hand-off scout → Thoth (mirror dari struct Rust
// src/ingest/content_search.rs: ContentSet/MainVideo/ContentResult/CommentInfo).
// Rust memakai #[serde(default)] TANPA deny_unknown_fields → field baru di sini
// aman (forward-compat); field yang tak dikenal Rust diabaikan.

import type { PersistedOcrFields } from './ocr_contract.ts';
import type { MainFootageDescriptor } from '../main_footage/contracts.ts';

export interface ProfileInfo {
  username?: string;
  display_name?: string;
  avatar_path?: string;
  [k: string]: any;
}

export interface MainVideo extends Partial<PersistedOcrFields> {
  url: string;
  title?: string;
  /** Caption/deskripsi asli postingan — WAJIB diisi scout (grounding narasi saat audio kosong). */
  description?: string;
  platform?: string;
  is_video?: boolean;
  /** Crop kartu postingan (PNG absolut) untuk main non-video. */
  image_path?: string;
  profile?: ProfileInfo;
  /** In-point detik: lewati konten sumber sebelum ini (cover/headline intro dipangkas). */
  trim_start?: number;
  /** Drop audio sumber ini dari mix (main subtitle-reaction tak terhindarkan). */
  mute_audio?: boolean;
  /** Region sensor blur ternormalisasi [0..1] + window waktu. */
  subtitle_blur?: { x: number; y: number; w: number; h: number; start?: number; end?: number }[];
  [k: string]: any;
}

export interface ContentResult extends Partial<PersistedOcrFields> {
  url: string;
  title?: string;
  platform?: string;
  is_video?: boolean;
  /** Keyword penemu footage ini (dari title+description+komentar main). */
  query?: string;
  /** Crop kartu postingan (PNG absolut) untuk footage non-video. */
  image_path?: string;
  /** In-point detik: lewati konten sumber sebelum ini (cover/headline intro dipangkas). */
  trim_start?: number;
  /** Drop audio sumber ini dari mix (main subtitle-reaction tak terhindarkan). */
  mute_audio?: boolean;
  /** Region sensor blur ternormalisasi [0..1] + window waktu. */
  subtitle_blur?: { x: number; y: number; w: number; h: number; start?: number; end?: number }[];
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
  main_footage?: MainFootageDescriptor;
  footage: ContentResult[];
  comments: CommentInfo[];
  figures?: Figure[];
  references?: Reference[];
  discourse?: Discourse;
  [k: string]: any;
}
