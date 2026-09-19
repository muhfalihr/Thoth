"""Pure, deterministic upgrade from a version 1 document to version 2.

The upgrade invents no asset, reads no file, and does not increment the
revision. Persistence assigns the new revision when it appends the result.
"""

from __future__ import annotations

from thoth_control_plane.domain.edit_document_v2 import (
    EditDocumentV2,
    TimelineTextClip,
    TimelineTrack,
    TrackKind,
)
from thoth_control_plane.domain.edit_documents import EditDocumentV1

#: Deterministic track identity, kind, and label for every version 2 role.
#: List order is also the persisted track order.
TIMELINE_TRACK_ROLES: tuple[tuple[str, TrackKind, str], ...] = (
    ("track_main_video", "main_video", "Main Video"),
    ("track_b_roll", "b_roll", "B-Roll"),
    ("track_overlay", "overlay", "Overlay"),
    ("track_caption", "caption", "Captions"),
    ("track_narration", "narration", "Narration"),
    ("track_music", "music", "Music"),
    ("track_sfx", "sfx", "SFX"),
)

#: Version 1 text clips migrate onto the text-compatible overlay track.
TEXT_TRACK_ID = "track_overlay"


def upgrade_edit_document_v1(document: EditDocumentV1) -> EditDocumentV2:
    """Return the version 2 projection of a version 1 document."""
    if not isinstance(document, EditDocumentV1):
        raise TypeError("upgrade requires a version 1 edit document")

    clips = [
        TimelineTextClip(
            kind="text",
            clip_id=clip.clip_id,
            track_id=TEXT_TRACK_ID,
            scene_id=clip.scene_id,
            from_frame=clip.start_frame,
            duration_in_frames=clip.duration_in_frames,
            ownership=clip.ownership,
            heading=clip.heading,
            body=clip.body,
            style_slot=clip.style_slot,
        )
        for clip in document.clips
    ]
    tracks = [
        TimelineTrack(
            track_id=track_id,
            kind=kind,
            label=label,
            order=order,
            clip_ids=[clip.clip_id for clip in clips] if track_id == TEXT_TRACK_ID else [],
        )
        for order, (track_id, kind, label) in enumerate(TIMELINE_TRACK_ROLES)
    ]
    return EditDocumentV2(
        schema_version=2,
        document_id=document.document_id,
        project_id=document.project_id,
        revision=document.revision,
        template=document.template,
        canvas=document.canvas,
        scenes=list(document.scenes),
        tracks=tracks,
        clips=clips,
        asset_refs=[],
    )
