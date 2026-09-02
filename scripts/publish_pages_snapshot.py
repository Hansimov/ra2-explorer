from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

try:
    from verify_pages_snapshot import SnapshotValidationError, verify_snapshot
except ModuleNotFoundError:  # Imported as scripts.publish_pages_snapshot in tests.
    from scripts.verify_pages_snapshot import SnapshotValidationError, verify_snapshot


GITHUB_API_ROOT = "https://api.github.com"
GITHUB_UPLOAD_ROOT = "https://uploads.github.com"
GITHUB_API_VERSION = "2022-11-28"
DEFAULT_REPOSITORY = "Hansimov/ra2-explorer"
DEFAULT_TARGET = "master"
AUTH_HEADER = "Author" "ization"
BEARER_PREFIX = "Bear" "er "
MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024
PART_BYTES = 8 * 1024 * 1024
UPLOAD_TIMEOUT_SECONDS = 3 * 60
UPLOAD_ATTEMPTS = 3
UPLOAD_RETRY_DELAY_SECONDS = 3
_REPOSITORY_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$"
)
_TAG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class SnapshotPublishError(RuntimeError):
    pass


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.removeprefix("export ").strip()] = value.strip().strip('"').strip("'")
    return values


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot_manifest(archive: Path) -> dict[str, Any]:
    with zipfile.ZipFile(archive) as bundle:
        member = next(
            (
                info
                for info in bundle.infolist()
                if PurePosixPath(info.filename.replace("\\", "/")).name == "manifest.json"
                and len(PurePosixPath(info.filename.replace("\\", "/")).parts) <= 2
            ),
            None,
        )
        if member is None:
            raise SnapshotPublishError("Pages ZIP 中没有根级 manifest.json")
        value = json.loads(bundle.read(member))
    if not isinstance(value, dict):
        raise SnapshotPublishError("Pages ZIP 清单格式无效")
    return value


def _data_manifest(archive: Path, snapshot: dict[str, Any]) -> dict[str, object]:
    parts: list[dict[str, object]] = []
    with archive.open("rb") as handle:
        index = 1
        while payload := handle.read(PART_BYTES):
            parts.append(
                {
                    "name": f"{archive.name}.part{index:02d}",
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
            index += 1
    return {
        "schema_version": 1,
        "snapshot_id": snapshot["snapshot_id"],
        "archive": archive.name,
        "sha256": _sha256_file(archive),
        "bytes": archive.stat().st_size,
        "unpacked_bytes": snapshot["payload"]["bytes"],
        "units": snapshot["catalog"]["entities"],
        "sounds": snapshot["catalog"]["audio"],
        "parts": parts,
        "contains_original_game_files": False,
    }


def _validate_repository(value: str) -> str:
    repository = value.strip()
    if not _REPOSITORY_PATTERN.fullmatch(repository):
        raise SnapshotPublishError("GitHub 仓库标识无效")
    return repository


def _validate_tag(value: str) -> str:
    tag = value.strip()
    if not _TAG_PATTERN.fullmatch(tag):
        raise SnapshotPublishError("GitHub 数据 Release 标签无效")
    if tag.startswith("v"):
        raise SnapshotPublishError("Pages 数据标签不能使用应用版本的 v 前缀")
    return tag


def _asset_url(repository: str, tag: str, asset_name: str) -> str:
    return (
        f"https://github.com/{quote(repository, safe='/')}/releases/download/"
        f"{quote(tag, safe='')}/{quote(asset_name, safe='')}"
    )


def _lock_manifest(
    *, repository: str, tag: str, data: dict[str, object]
) -> dict[str, object]:
    archive = str(data["archive"])
    parts = [
        {
            **part,
            "url": _asset_url(repository, tag, str(part["name"])),
        }
        for part in data["parts"]
        if isinstance(part, dict)
    ]
    return {
        "schema_version": 1,
        "provider": "github-release",
        "repository": repository,
        "tag": tag,
        "asset": archive,
        "parts": parts,
        "snapshot_id": data["snapshot_id"],
        "sha256": data["sha256"],
        "bytes": data["bytes"],
        "unpacked_bytes": data["unpacked_bytes"],
        "units": data["units"],
        "sounds": data["sounds"],
    }


def _github_headers(auth_value: str, *, content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        AUTH_HEADER: BEARER_PREFIX + auth_value,
        "User-Agent": "ra2-explorer-pages-publisher/1",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _request_json(
    url: str,
    *,
    auth_value: str,
    method: str = "GET",
    payload: bytes | None = None,
    content_type: str | None = None,
    allow_not_found: bool = False,
    timeout: float = 300,
) -> dict[str, Any] | None:
    request = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers=_github_headers(auth_value, content_type=content_type),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_API_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if allow_not_found and error.code == 404:
            return None
        request_id = error.headers.get("x-github-request-id", "").strip()
        suffix = f" · request {request_id}" if request_id else ""
        raise SnapshotPublishError(f"GitHub API 返回 HTTP {error.code}{suffix}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SnapshotPublishError(f"无法连接 GitHub API：{type(error).__name__}") from error
    if len(raw) > MAX_API_RESPONSE_BYTES:
        raise SnapshotPublishError("GitHub API 响应超过安全限制")
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotPublishError("GitHub API 响应无法解析") from error
    if not isinstance(value, dict):
        raise SnapshotPublishError("GitHub API 响应结构无效")
    return value


def _release_body(data: dict[str, object]) -> str:
    return "\n".join(
        (
            "RA2 Explorer GitHub Pages 精简数据快照。",
            "",
            f"- 快照：`{data['snapshot_id']}`",
            f"- 单位：{data['units']}",
            f"- 声音：{data['sounds']}",
            f"- 压缩包：{int(data['bytes']) / 1024 / 1024:.1f} MiB",
            f"- Release 分片：{len(data['parts'])}",
            f"- SHA-256：`{data['sha256']}`",
            "- 仅含浏览器所需的派生资源，不含原始游戏文件。",
        )
    )


def _find_asset(release: dict[str, Any], name: str) -> dict[str, Any] | None:
    assets = release.get("assets")
    if not isinstance(assets, list):
        return None
    return next(
        (
            asset
            for asset in assets
            if isinstance(asset, dict) and asset.get("name") == name
        ),
        None,
    )


def _upload_asset(
    url: str,
    *,
    archive: Path,
    auth_value: str,
) -> dict[str, Any]:
    executable = shutil.which("curl.exe" if os.name == "nt" else "curl")
    if executable is None:
        executable = shutil.which("curl")
    if executable is None:
        raise SnapshotPublishError("发布 Pages 数据需要 curl")
    command = [
        executable,
        "--fail",
        "--show-error",
        "--http1.1",
        "--connect-timeout",
        "15",
        "--max-time",
        str(UPLOAD_TIMEOUT_SECONDS),
        "--progress-bar",
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        f"{AUTH_HEADER}: {BEARER_PREFIX}{auth_value}",
        "-H",
        f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
        "-H",
        "Content-Type: application/zip",
        "--data-binary",
        f"@{archive}",
        url,
    ]
    completed: subprocess.CompletedProcess[bytes] | None = None
    last_error: BaseException | None = None
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        print(
            f"[pages] 分片上传尝试 {attempt}/{UPLOAD_ATTEMPTS}，"
            f"单次最长 {UPLOAD_TIMEOUT_SECONDS} 秒",
            file=sys.stderr,
            flush=True,
        )
        try:
            completed = subprocess.run(
                command,
                check=False,
                stdout=subprocess.PIPE,
                timeout=UPLOAD_TIMEOUT_SECONDS + 30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            last_error = error
            completed = None
        if completed is not None and completed.returncode == 0:
            break
        if completed is not None:
            last_error = RuntimeError(f"curl {completed.returncode}")
        if attempt < UPLOAD_ATTEMPTS:
            time.sleep(UPLOAD_RETRY_DELAY_SECONDS)
    if completed is None or completed.returncode != 0:
        detail = type(last_error).__name__ if last_error else "unknown"
        if isinstance(last_error, RuntimeError):
            detail = str(last_error)
        raise SnapshotPublishError(
            f"GitHub 数据上传在 {UPLOAD_ATTEMPTS} 次尝试后失败：{detail}"
        ) from last_error
    if len(completed.stdout) > MAX_API_RESPONSE_BYTES:
        raise SnapshotPublishError("GitHub 上传响应超过安全限制")
    try:
        value = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotPublishError("GitHub 上传响应无法解析") from error
    if not isinstance(value, dict):
        raise SnapshotPublishError("GitHub 上传响应结构无效")
    return value


def publish_snapshot(
    archive: Path,
    *,
    repository: str,
    tag: str,
    target: str,
    auth_value: str,
    write_lock: Path | None,
) -> dict[str, object]:
    resolved = archive.resolve()
    repository = _validate_repository(repository)
    tag = _validate_tag(tag)
    if not auth_value.strip():
        raise SnapshotPublishError("缺少 GitHub 发布令牌")
    print("[pages] 审计待发布数据包", file=sys.stderr, flush=True)
    try:
        verify_snapshot(resolved)
    except SnapshotValidationError as error:
        raise SnapshotPublishError(str(error)) from error
    snapshot = _snapshot_manifest(resolved)
    data = _data_manifest(resolved, snapshot)
    release_url = (
        f"{GITHUB_API_ROOT}/repos/{quote(repository, safe='/')}/releases/tags/"
        f"{quote(tag, safe='')}"
    )
    release = _request_json(
        release_url,
        auth_value=auth_value,
        allow_not_found=True,
    )
    if release is None:
        payload = json.dumps(
            {
                "tag_name": tag,
                "target_commitish": target,
                "name": f"Pages Data {tag.removeprefix('pages-data-')}",
                "body": _release_body(data),
                "draft": False,
                "prerelease": False,
            }
        ).encode()
        release = _request_json(
            f"{GITHUB_API_ROOT}/repos/{quote(repository, safe='/')}/releases",
            auth_value=auth_value,
            method="POST",
            payload=payload,
            content_type="application/json",
        )
    if release is None or not isinstance(release.get("id"), int):
        raise SnapshotPublishError("GitHub Release 没有有效 ID")
    existing_assets = {
        str(asset.get("name")): asset
        for asset in release.get("assets", [])
        if isinstance(asset, dict)
    }
    parts = data["parts"]
    if not isinstance(parts, list):
        raise SnapshotPublishError("Pages 数据分片清单无效")
    with resolved.open("rb") as source, tempfile.TemporaryDirectory(
        prefix="ra2exp-pages-parts-"
    ) as temporary:
        temporary_root = Path(temporary)
        for index, part in enumerate(parts, start=1):
            if not isinstance(part, dict):
                raise SnapshotPublishError("Pages 数据分片结构无效")
            name = str(part["name"])
            expected_size = int(part["bytes"])
            expected_digest = f"sha256:{part['sha256']}"
            existing = existing_assets.get(name)
            if existing is not None:
                digest = str(existing.get("digest") or "")
                if existing.get("size") != expected_size or (
                    digest and digest != expected_digest
                ):
                    raise SnapshotPublishError(f"GitHub Release 分片内容冲突：{name}")
                source.seek(expected_size, 1)
                print(
                    f"[pages] 跳过已校验分片 {index}/{len(parts)}",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            payload = source.read(expected_size)
            if len(payload) != expected_size or hashlib.sha256(payload).hexdigest() != part[
                "sha256"
            ]:
                raise SnapshotPublishError(f"本地数据分片校验失败：{name}")
            part_path = temporary_root / name
            part_path.write_bytes(payload)
            print(
                f"[pages] 上传分片 {index}/{len(parts)} ({expected_size / 1024 / 1024:.1f} MiB)",
                file=sys.stderr,
                flush=True,
            )
            try:
                uploaded = _upload_asset(
                    (
                        f"{GITHUB_UPLOAD_ROOT}/repos/{quote(repository, safe='/')}/releases/"
                        f"{release['id']}/assets?name={quote(name, safe='')}"
                    ),
                    archive=part_path,
                    auth_value=auth_value,
                )
            except SnapshotPublishError:
                refreshed = _request_json(release_url, auth_value=auth_value)
                recovered = _find_asset(refreshed or {}, name)
                if recovered is None:
                    raise
                print(
                    f"[pages] 已从 Release 恢复上传结果 {index}/{len(parts)}",
                    file=sys.stderr,
                    flush=True,
                )
                uploaded = recovered
            if uploaded.get("size") != expected_size:
                raise SnapshotPublishError(f"GitHub Release 分片大小不一致：{name}")
            digest = str(uploaded.get("digest") or "")
            if digest and digest != expected_digest:
                raise SnapshotPublishError(f"GitHub Release 分片摘要不一致：{name}")
    lock = _lock_manifest(repository=repository, tag=tag, data=data)
    if write_lock:
        write_lock.parent.mkdir(parents=True, exist_ok=True)
        write_lock.write_text(
            json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return lock


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="发布固定版本的 Pages 精简数据快照")
    parser.add_argument("archive", type=Path, help="通过审计的 Pages ZIP")
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY, help="GitHub 仓库")
    parser.add_argument("--tag", required=True, help="独立的数据 Release 标签")
    parser.add_argument("--target", default=DEFAULT_TARGET, help="数据标签对应的分支或提交")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(".secrets/local.env"),
        help="只在本机读取的凭据文件",
    )
    parser.add_argument(
        "--write-lock",
        type=Path,
        default=Path("packaging/pages-data.json"),
        help="写入供 CI 使用的小型锁定清单",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    values = _load_env_file(args.env_file)
    auth_value = (
        os.environ.get("GITHUB_TOKEN_RA2_EXPLORER")
        or os.environ.get("GH_TOKEN")
        or values.get("GITHUB_TOKEN_RA2_EXPLORER", "")
    )
    try:
        result = publish_snapshot(
            args.archive,
            repository=args.repository,
            tag=args.tag,
            target=args.target,
            auth_value=auth_value,
            write_lock=args.write_lock,
        )
    except (OSError, SnapshotPublishError, ValueError, zipfile.BadZipFile) as error:
        print(f"pages snapshot publish failed: {error}", file=sys.stderr)
        return 1
    print(
        "pages snapshot publish passed "
        f"({result['snapshot_id']}, {result['tag']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
