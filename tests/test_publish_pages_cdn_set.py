from __future__ import annotations

import pytest

from scripts.publish_pages_cdn import PagesCdnPublishError
from scripts.publish_pages_cdn_set import PACKAGE_PROFILES, compose_lock


def _part(profile: str, package: str, index: int) -> dict[str, object]:
    return {
        "profile": profile,
        "package": package,
        "version": "1.2.3",
        "base_url": f"https://cdn.example/{package}@1.2.3/data",
        "snapshot_id": "snapshot-test",
        "routes": [f"route-{index}/"],
        "included": [f"content-{index}"],
        "files": index + 1,
        "bytes": (index + 1) * 10,
        "package_bytes": (index + 1) * 5,
        "published": True,
    }


def _parts() -> list[dict[str, object]]:
    return [
        _part(profile, package, index)
        for index, (profile, package) in enumerate(PACKAGE_PROFILES)
    ]


def test_compose_pages_cdn_lock_routes_every_profile() -> None:
    parts = _parts()

    lock = compose_lock(parts, "1.2.3")

    assert lock["schema_version"] == 2
    assert lock["snapshot_id"] == "snapshot-test"
    assert lock["files"] == 10
    assert lock["bytes"] == 100
    assert lock["package_bytes"] == 50
    assert len(lock["routes"]) == len(PACKAGE_PROFILES)
    assert lock["published"] is True


def test_compose_pages_cdn_lock_rejects_mixed_snapshots() -> None:
    parts = _parts()
    parts[-1]["snapshot_id"] = "other-snapshot"

    with pytest.raises(PagesCdnPublishError, match="同一份快照"):
        compose_lock(parts, "1.2.3")


def test_compose_pages_cdn_lock_rejects_duplicate_routes() -> None:
    parts = _parts()
    parts[-1]["routes"] = ["route-0/"]

    with pytest.raises(PagesCdnPublishError, match="路由重复"):
        compose_lock(parts, "1.2.3")
