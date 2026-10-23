#!/usr/bin/env python3
"""Wrap the pinned legacy release ZIP as MCPB without executing its runtime.

Usage:
    python mcp/scripts/build-mcpb.py --source-zip ORIGINAL.zip --output-dir NEW_DIR

NEW_DIR must not exist. It receives .staging/, the MCPB, and build-report.json.
The archive is deterministic for identical input bytes and Python/zlib tooling.
Credential entries are excluded before their content is opened or decompressed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile
import zlib


SOURCE_SHA256 = "6aac1c0b5c48d888cbc286ce059293a08f6eb878f21bd3262ade2a243c3615b8"
SOURCE_ROOT = "umouse-mcp-os-win-x64"
RUNTIME_VERSION = "0.1.0"
BUNDLE_VERSION = "0.1.1"
ARTIFACT_NAME = f"umouse-mcp-{BUNDLE_VERSION}-win-x64.mcpb"
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
ROOT_EXCLUSIONS = {
    "readme.md": "Replaced with the MCPB-specific README.",
    "install-agents.cmd": "MCPB installation is managed by the client.",
    "umouse-mcp.cmd": "Replaced with the MCPB launcher.",
}
REQUIRED_RUNTIME_FILES = {
    "package.json",
    "mcp/package.json",
    "mcp/dist/index.js",
    "mcp/dist/env.js",
    "doc/umouse-sdk.js",
    "doc/typer.js",
    "lib/uMouseSdk.dll",
    "lib/typer.dll",
    "lib/avcodec-58.dll",
    "lib/avutil-56.dll",
    "lib/msvcp140.dll",
    "lib/vcruntime140.dll",
    "lib/vcruntime140_1.dll",
    "mcp/voice-ui/umouse-voice-ui.exe",
    "mcp/scripts/transcribe-windows.ps1",
    "node_modules/koffi/build/koffi/win32_x64/koffi.node",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "COPYING.LGPLv2.1",
    "LICENSE.hidapi-bsd",
    "THIRD_PARTY_LICENSES.txt",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalized_member(info: zipfile.ZipInfo) -> tuple[str, bool]:
    """Reject unsafe names and return a path relative to the known root."""
    name = info.filename.replace("\\", "/")
    is_directory = name.endswith("/")
    parts = name.rstrip("/").split("/")
    if not parts or parts[0] != SOURCE_ROOT:
        raise ValueError(f"Unexpected archive root: {info.filename!r}")
    for part in parts:
        if not part or part in (".", "..") or part.endswith((" ", ".")):
            raise ValueError(f"Unsafe archive path: {info.filename!r}")
        if re.search(r'[<>:"|?*\x00-\x1f]', part):
            raise ValueError(f"Invalid Windows archive path: {info.filename!r}")
        if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part):
            raise ValueError(f"Reserved Windows archive path: {info.filename!r}")
    mode = info.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ValueError(f"Unsupported archive entry type: {info.filename!r}")
    if info.flag_bits & 1:
        raise ValueError(f"Encrypted archive entry: {info.filename!r}")
    relative = "/".join(parts[1:])
    if not relative and not is_directory:
        raise ValueError("The archive root must be a directory.")
    return relative, is_directory


def exclusion_reason(relative: str) -> str | None:
    if PurePosixPath(relative).name.casefold() == "sinicloud_asr.json":
        return "Credential file excluded without opening or decompressing its content."
    return ROOT_EXCLUSIONS.get(relative.casefold())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-zip", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    source = args.source_zip.expanduser().resolve(strict=True)
    output_arg = args.output_dir.expanduser()
    if os.path.lexists(output_arg):
        raise ValueError("Output directory already exists; choose a new directory.")
    output = output_arg.resolve(strict=False)
    if not source.is_file():
        raise ValueError("Source ZIP must be a regular file.")
    actual_source_sha256 = sha256_file(source)
    if actual_source_sha256 != SOURCE_SHA256:
        raise ValueError(f"Source ZIP SHA-256 mismatch: expected {SOURCE_SHA256}, got {actual_source_sha256}")

    repository = Path(__file__).resolve().parents[2]
    overlay_paths = {
        "manifest.json": repository / "mcpb" / "manifest.json",
        "launcher.cjs": repository / "mcpb" / "launcher.cjs",
        "LICENSE": repository / "LICENSE",
        "README.md": repository / "mcpb" / "README.md",
    }
    overlays = {}
    for name, path in overlay_paths.items():
        if not path.is_file():
            raise ValueError(f"Required packaging file is missing: {path}")
        overlays[name] = path.read_bytes()
    manifest = json.loads(overlays["manifest.json"])
    if manifest.get("version") != BUNDLE_VERSION or manifest.get("server", {}).get("entry_point") != "launcher.cjs":
        raise ValueError("Manifest version or entry point does not match this packaging script.")

    retained = []
    excluded = []
    additions = []
    with zipfile.ZipFile(source) as original:
        members = {}
        seen_paths = {}
        file_keys = set()
        for info in original.infolist():
            relative, is_directory = normalized_member(info)
            if not relative:
                continue
            key = relative.casefold()
            if key in seen_paths:
                raise ValueError(f"Duplicate or case-conflicting archive path: {relative}")
            seen_paths[key] = relative
            if is_directory:
                continue
            file_keys.add(key)
            reason = exclusion_reason(relative)
            if reason:
                excluded.append({"source_path": info.filename, "path": relative, "reason": reason})
                continue
            members[relative] = info
        for relative in seen_paths.values():
            for parent in PurePosixPath(relative).parents:
                if str(parent) != "." and str(parent).casefold() in file_keys:
                    raise ValueError(f"File/directory collision in archive: {relative}")
        missing = REQUIRED_RUNTIME_FILES - members.keys()
        if missing:
            raise ValueError(f"Required runtime files missing: {', '.join(sorted(missing))}")
        for name in overlays:
            if name.casefold() in {p.casefold() for p in members}:
                raise ValueError(f"Overlay unexpectedly replaces a retained runtime file: {name}")
        package = json.loads(original.read(members["package.json"]).decode("utf-8-sig"))
        if package.get("version") != RUNTIME_VERSION:
            raise ValueError("The source package is not the expected legacy runtime version.")

        output.mkdir(parents=True, exist_ok=False)
        staging = output / ".staging"
        staging.mkdir()
        for relative in sorted(members):
            info = members[relative]
            target = staging.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            byte_count = 0
            with original.open(info) as src, target.open("xb") as dst:
                for block in iter(lambda: src.read(1024 * 1024), b""):
                    dst.write(block)
                    digest.update(block)
                    byte_count += len(block)
            if byte_count != info.file_size:
                raise ValueError(f"Unexpected extracted size: {relative}")
            retained.append({"path": relative, "size": byte_count, "sha256": digest.hexdigest()})

    for name in sorted(overlays):
        content = overlays[name]
        with (staging / name).open("xb") as stream:
            stream.write(content)
        additions.append({
            "path": name,
            "repository_path": overlay_paths[name].relative_to(repository).as_posix(),
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        })

    artifact = output / ARTIFACT_NAME
    output_files = sorted([item["path"] for item in retained + additions])
    with zipfile.ZipFile(artifact, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for relative in output_files:
            info = zipfile.ZipInfo(relative, FIXED_ZIP_TIME)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, staging.joinpath(*PurePosixPath(relative).parts).read_bytes(), compresslevel=9)

    expected_files = {item["path"]: item for item in retained + additions}
    with zipfile.ZipFile(artifact) as bundle:
        if set(bundle.namelist()) != set(expected_files):
            raise ValueError("Final bundle file list does not match the build plan.")
        for name, expected in expected_files.items():
            actual = hashlib.sha256(bundle.read(name)).hexdigest()
            if actual != expected["sha256"]:
                raise ValueError(f"Final bundle byte verification failed: {name}")

    artifact_sha256 = sha256_file(artifact)
    report = {
        "bundle_version": BUNDLE_VERSION,
        "runtime_version": RUNTIME_VERSION,
        "source_zip": str(source),
        "source_sha256": actual_source_sha256,
        "artifact": ARTIFACT_NAME,
        "artifact_sha256": artifact_sha256,
        "artifact_size": artifact.stat().st_size,
        "staging_directory": ".staging",
        "tooling": {"python": sys.version.split()[0], "zlib": zlib.ZLIB_RUNTIME_VERSION},
        "archive_format": {"timestamp": list(FIXED_ZIP_TIME), "compression": "deflate", "compression_level": 9, "file_mode": "100644", "entry_order": "sorted paths"},
        "verification": {"retained_runtime_bytes": "unchanged", "final_archive_bytes": "all files verified", "credential_entries_opened": 0},
        "excluded": sorted(excluded, key=lambda item: item["path"]),
        "added": additions,
        "retained": retained,
    }
    report_path = output / "build-report.json"
    with report_path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(report, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    print(json.dumps({
        "artifact": str(artifact), "sha256": artifact_sha256,
        "report": str(report_path), "retained_files": len(retained),
        "excluded_files": len(excluded), "added_files": len(additions),
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        print(f"build-mcpb: {error}", file=sys.stderr)
        raise SystemExit(1)
