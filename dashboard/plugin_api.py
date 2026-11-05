"""WSL Files backend, mounted at /api/plugins/wsl-files/.

Small file-manager API for the desktop page: list, read/write text,
upload, new file/folder, rename, delete (to trash). Every path is resolved
and must stay inside the allowed roots; secret-ish names are refused outright.

Allowed roots come from the plugin's `roots` setting
(config.yaml: plugins.entries.wsl-files.settings.roots), default ["~"].
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter()

PLUGIN_ID = "wsl-files"
HOME = Path.home()
DEFAULT_ROOTS = ["~"]
BLOCKED_NAMES = {".ssh", ".gnupg", ".env", "auth.json", ".aws", ".netrc"}
TRASH_DIR = HOME / ".local/share/Trash/files"
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
CHUNK = 1024 * 1024


def _allowed_roots() -> list[Path]:
    """Roots from the plugin setting, read per request so edits apply without a restart."""
    try:
        from hermes_cli.config import cfg_get, load_config_readonly

        raw = cfg_get(load_config_readonly(), "plugins", "entries", PLUGIN_ID, "settings", "roots", default=None)
    except Exception:  # running outside Hermes (tests) or unreadable config
        raw = None
    roots = raw if isinstance(raw, list) and raw else DEFAULT_ROOTS
    return [Path(os.path.expanduser(str(r))).resolve() for r in roots]


def _safe(path: str) -> Path:
    """Resolve `path` (absolute or ~) and refuse anything outside the roots."""
    if not path:
        raise HTTPException(400, "path is required")
    p = Path(os.path.expanduser(path)).resolve()
    if not any(p == root or root in p.parents for root in _allowed_roots()):
        raise HTTPException(403, f"{p} is outside the allowed folders")
    if BLOCKED_NAMES & set(p.parts):
        raise HTTPException(403, "That path is blocked (secrets)")
    return p


def _safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise HTTPException(400, "Invalid name")
    return name


def _entry(p: Path) -> dict:
    try:
        st = p.stat()
        is_dir = p.is_dir()
    except OSError:  # broken symlink etc.
        return {"name": p.name, "path": str(p), "dir": False, "size": 0, "mtime": 0}
    return {"name": p.name, "path": str(p), "dir": is_dir, "size": 0 if is_dir else st.st_size, "mtime": st.st_mtime}


@router.get("/roots")
async def roots():
    return {"home": str(HOME), "roots": [str(r) for r in _allowed_roots() if r.exists()]}


@router.get("/list")
async def list_dir(path: str):
    p = _safe(path)
    if not p.is_dir():
        raise HTTPException(404, "Not a folder")
    try:
        children = [c for c in p.iterdir() if c.name not in BLOCKED_NAMES]
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    entries = sorted((_entry(c) for c in children), key=lambda e: (not e["dir"], e["name"].lower()))
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "entries": entries}


@router.get("/read")
async def read_text(path: str):
    p = _safe(path)
    if not p.is_file():
        raise HTTPException(404, "Not a file")
    if p.stat().st_size > MAX_TEXT_BYTES:
        raise HTTPException(413, "File too large to edit here (2 MB max)")
    data = p.read_bytes()
    if b"\0" in data[:8192]:
        raise HTTPException(415, "Binary file")
    try:
        return {"path": str(p), "content": data.decode("utf-8"), "mtime": p.stat().st_mtime}
    except UnicodeDecodeError:
        raise HTTPException(415, "Not UTF-8 text")


class WriteBody(BaseModel):
    path: str
    content: str
    mtime: float | None = None  # last-seen mtime; refuse if file changed since


@router.post("/write")
async def write_text(body: WriteBody):
    p = _safe(body.path)
    if body.mtime is not None and p.exists() and abs(p.stat().st_mtime - body.mtime) > 1e-6:
        raise HTTPException(409, "File changed on disk since you opened it")
    p.write_text(body.content, encoding="utf-8")
    return {"ok": True, "mtime": p.stat().st_mtime}


@router.post("/upload")
async def upload(dir: str, file: UploadFile = File(...), overwrite: bool = False):
    folder = _safe(dir)
    if not folder.is_dir():
        raise HTTPException(404, "Target folder not found")
    target = _safe(str(folder / _safe_name(Path(file.filename or "").name)))
    if target.exists() and not overwrite:
        raise HTTPException(409, f"{target.name} already exists")
    # Stream to a temp file next to the target, then rename: no half-written files.
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".upload", dir=folder)
    total = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := await file.read(CHUNK):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File too large (200 MB max)")
                out.write(chunk)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"ok": True, "path": str(target), "size": total}


class PathBody(BaseModel):
    path: str


class RenameBody(BaseModel):
    path: str
    name: str


@router.post("/mkdir")
async def mkdir(body: PathBody):
    p = _safe(body.path)
    if p.exists():
        raise HTTPException(409, "Already exists")
    p.mkdir(parents=True)
    return {"ok": True, "path": str(p)}


@router.post("/new-file")
async def new_file(body: PathBody):
    p = _safe(body.path)
    if p.exists():
        raise HTTPException(409, "Already exists")
    p.touch()
    return {"ok": True, "path": str(p)}


@router.post("/rename")
async def rename(body: RenameBody):
    src = _safe(body.path)
    if not src.exists():
        raise HTTPException(404, "Not found")
    dst = _safe(str(src.parent / _safe_name(body.name)))
    if dst.exists():
        raise HTTPException(409, f"{dst.name} already exists")
    src.rename(dst)
    return {"ok": True, "path": str(dst)}


@router.post("/delete")
async def delete(body: PathBody):
    """Move to ~/.local/share/Trash/files (recoverable), never rm."""
    p = _safe(body.path)
    if not p.exists():
        raise HTTPException(404, "Not found")
    if p in _allowed_roots():
        raise HTTPException(403, "Can't delete a root folder")
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    dest = TRASH_DIR / f"{p.name}.{int(time.time())}"
    shutil.move(str(p), str(dest))
    return {"ok": True, "trashed_to": str(dest)}
