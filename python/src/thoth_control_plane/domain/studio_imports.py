"""Bounded Studio import source projection, its server-side identity, and its public inventory."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal, TypeAlias
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field, model_validator

from thoth_control_plane.domain.edit_documents import BodyText, ShortText
from thoth_control_plane.domain.models import ProjectId, StrictModel

SourceRole: TypeAlias = Literal["main", "main_footage", "footage", "comment"]
MediaKind: TypeAlias = Literal["video", "image", "none"]
Disposition: TypeAlias = Literal["unresolved", "attached", "excluded"]

ROLE_ORDER: tuple[SourceRole, ...] = ("main", "main_footage", "footage", "comment")
MAX_SOURCE_ITEMS = 400
MAX_UNSUPPORTED_FIELDS = 400
SourceKey = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ItemOrder = Annotated[int, Field(ge=0, lt=MAX_SOURCE_ITEMS)]
Reason = Annotated[str, Field(min_length=1, max_length=200)]


def _canonical_web_url(value: str) -> str:
    """Accept only an http(s) address with no credentials, query, or fragment."""
    parts = urlsplit(value)
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or "@" in parts.netloc
        or "?" in value
        or "#" in value
        or "\\" in value
    ):
        raise ValueError("source_url must be a canonical http(s) address")
    return value


CanonicalUrl = Annotated[str, Field(max_length=2_048), AfterValidator(_canonical_web_url)]


class StudioSourceItem(StrictModel):
    """One ordered creative input of a Content Set, without host paths or signed queries."""

    role: SourceRole
    order: ItemOrder
    title: ShortText | None
    text: BodyText | None
    platform: Annotated[str, Field(min_length=1, max_length=64)] | None
    source_url: CanonicalUrl | None
    media_kind: MediaKind
    trim_start_seconds: Annotated[float, Field(gt=0, le=86_400)] | None


class StudioUnsupportedField(StrictModel):
    """A creative field Studio cannot represent, named by where it came from."""

    field: Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]
    role: SourceRole | None
    order: ItemOrder | None
    reason: Reason


class StudioSourceProjection(StrictModel):
    """The whole first-mode source: one main item, then main footage, footage, and comments."""

    items: Annotated[list[StudioSourceItem], Field(min_length=1, max_length=MAX_SOURCE_ITEMS)]
    unsupported: Annotated[list[StudioUnsupportedField], Field(max_length=MAX_UNSUPPORTED_FIELDS)]

    @model_validator(mode="after")
    def _ordered_roles(self) -> StudioSourceProjection:
        keys = [(ROLE_ORDER.index(item.role), item.order) for item in self.items]
        if keys[0] != (0, 0) or keys != sorted(keys):
            raise ValueError("items must start with main and follow role order")
        for role in ROLE_ORDER:
            orders = [item.order for item in self.items if item.role == role]
            if orders != list(range(len(orders))) or (
                role in {"main", "main_footage"} and len(orders) > 1
            ):
                raise ValueError(f"{role} items must be numbered from zero without gaps")
        return self


class StudioImportItem(StrictModel):
    """Public inventory entry: a media item to attach or a field to exclude. Never an address."""

    item_id: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    role: SourceRole | None
    order: ItemOrder | None
    label: Annotated[str, Field(min_length=1, max_length=300)]
    platform: str | None
    media_kind: MediaKind
    reason: Reason | None
    disposition: Disposition


class StudioSourceInspection(StrictModel):
    """What opening a source in Studio would import, before anything is created."""

    project_id: ProjectId
    source_key: SourceKey
    items: list[StudioImportItem]


def source_key(projection: StudioSourceProjection) -> str:
    """SHA-256 of the canonical projection: sorted object keys, item order preserved."""
    canonical = json.dumps(
        projection.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _media_label(item: StudioSourceItem) -> str:
    if item.title:
        return item.title
    if item.role == "main_footage":
        return "Main footage"
    return f"{item.role.capitalize()} {item.order + 1}"


def inventory(projection: StudioSourceProjection) -> list[StudioImportItem]:
    """Every media item and unsupported field, each awaiting an attach or exclude decision."""
    media = [
        StudioImportItem(
            item_id=f"{item.role}_{item.order:03d}",
            role=item.role,
            order=item.order,
            label=_media_label(item),
            platform=item.platform,
            media_kind=item.media_kind,
            reason=None,
            disposition="unresolved",
        )
        for item in projection.items
        if item.media_kind != "none"
    ]
    unsupported = [
        StudioImportItem(
            item_id=f"unsupported_{index:03d}",
            role=field.role,
            order=field.order,
            label=field.field,
            platform=None,
            media_kind="none",
            reason=field.reason,
            disposition="unresolved",
        )
        for index, field in enumerate(projection.unsupported)
    ]
    return media + unsupported


def inspect_source(project_id: str, projection: StudioSourceProjection) -> StudioSourceInspection:
    """Compute the source identity on the server and list what needs a decision."""
    return StudioSourceInspection(
        project_id=project_id, source_key=source_key(projection), items=inventory(projection)
    )
