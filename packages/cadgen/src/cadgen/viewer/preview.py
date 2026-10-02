"""What a build of a STEP file is doing, for the viewer's status.

The viewer always shows the saved file (STORE.md 9b). This read-only adapter matches the
daemon's jobs to the file's output path and store and reports the newest: whether it is queued
or running, how far it has got, whether it failed and why -- and, once it has finished, whether
the file moved past it (``superseded``), when its failure is no longer the news. A daemon
restart expires this channel; the catalog keeps serving the bytes on disk.

The one geometry it names is the saved file's own: a build that composed its document tree
before writing the STEP announces that tree, which is the catalog's tree for the file once it
is written. ``preview`` carries its hash and store URL while the build runs, and after it
finishes only while the file is the one it saved with that tree -- never an authored tree.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from cadgen.store.paths import store_root

from .backend import normalized_file_ref, require_contained
from .build_progress import _RUNNING, _daemon_jobs


def _preview_target(root_path: str, file_ref: str, *, lazy: bool = False) -> str:
    ref = normalized_file_ref(file_ref)
    if not ref or Path(ref).suffix.lower() not in {".step", ".stp"}:
        raise ValueError("A build status requires a STEP output path")
    target = os.path.abspath(ref if os.path.isabs(ref) else os.path.join(root_path, ref))
    require_contained(root_path, target)
    # A lazy root (a whole filesystem) serves what it is asked for, as the asset route does.
    if not lazy and any(part.startswith(".") for part in Path(os.path.relpath(target, root_path)).parts):
        raise ValueError("Hidden output paths are not served")
    return target


def preview_update(root_path: str, file_ref: str, *, after: str | None = None, lazy: bool = False) -> dict:
    """Wake for ledger changes, then answer as :func:`preview_status`."""
    target = _preview_target(root_path, file_ref, lazy=lazy)  # refuse invalid paths before waiting
    from cadgen.daemon.client import watch_jobs

    update = watch_jobs(after, output=os.path.realpath(target), store_root=os.path.realpath(store_root()))
    if update is None:
        return preview_status(root_path, file_ref, lazy=lazy)
    result = preview_status(root_path, file_ref, jobs=update["jobs"], lazy=lazy)
    result["feedCursor"] = update["jobsCursor"]
    if update.get("jobsWatchLimited"):
        result["feedLimited"] = True
    return result


def preview_status(root_path: str, file_ref: str, *, jobs: list[dict] | None = None, lazy: bool = False) -> dict:
    file_path = _preview_target(root_path, file_ref, lazy=lazy)
    # Match the catalog's root-relative file identity. An absolute path in a
    # provisional entry would be written into ?file= by the selection effect,
    # whose URL normalizer removes its leading slash.
    display_file = os.path.relpath(file_path, root_path).replace(os.sep, "/")
    target = os.path.realpath(file_path)
    active_store = os.path.realpath(store_root())
    listed = jobs if jobs is not None else _daemon_jobs(time.time(), max_age=0.08)
    matching = [
        job for job in listed
        if job.get("tool") == "run"
        and job.get("editingProducer", True)
        and job.get("storeRoot") and os.path.realpath(job["storeRoot"]) == active_store
        and target in {os.path.realpath(p) for p in job.get("outputs", [])}
    ]
    if not matching:
        return {"output": target, "file": display_file, "state": "disconnected", "revision": None}
    latest = max(matching, key=lambda job: int(job.get("sequence") or 0))
    result = {
        "output": target,
        "file": display_file,
        "epoch": latest.get("epoch"),
        "revision": int(latest.get("sequence") or 0),
        "request": latest.get("id"),
        "state": latest.get("state"),
        "phase": latest.get("phase"),
        "detail": latest.get("detail"),
        "updatedAt": round(float(latest.get("updatedAt") or 0.0) * 1000.0),
        "error": latest.get("error"),
    }
    if _superseded(latest, target):
        # The file moved on after this build finished: built by another installation, or once
        # its daemon has gone; a checkout; a STEP written by hand. Its failure is no longer the news.
        result["superseded"] = True
        result["error"] = None
        return result
    preview = _document_preview(latest, target)
    if preview is not None:
        result["preview"] = preview
    return result


def _document_preview(job: dict, target: str) -> dict | None:
    """The saved document's tree ``job`` announced for ``target`` before writing it, while that is
    still the news: the build is running, or it saved exactly that tree (a failed build, or one
    whose save read back another tree, shows the catalog). Its URL names the build's attested
    surface producer, as a saved document's index entry does, so the view's surfaces are the ones
    the saved file's view selects."""
    announced = (job.get("documentPreviews") or {}).get(target)
    tree = announced.get("tree") if isinstance(announced, dict) else None
    if not isinstance(tree, str) or not tree:
        return None
    saved = (job.get("savedResults") or {}).get(target)
    if job.get("state") not in _RUNNING and not (
        job.get("state") == "done" and isinstance(saved, dict) and saved.get("tree") == tree
    ):
        return None
    from .scanner import _store_asset_url

    producer = None
    if announced.get("surfaceProducer") is not None:
        from cadgen.store.surfaces import producer_fields

        try:
            producer = producer_fields(announced["surfaceProducer"])
        except (ValueError, TypeError):
            producer = None
    # The catalog's URL for the file once its build has saved it (scanner._store_asset_url).
    return {"tree": tree, "url": _store_asset_url(tree, producer=producer)}


def _superseded(job: dict, target: str) -> bool:
    """Whether the file changed after ``job`` finished. A build that saved is judged by bytes: the
    file is no longer the one it wrote. One that saved nothing (it failed, or it changed nothing)
    by time: the file was written after the build ended. A file that is not there was not -- a
    failed first build never wrote one -- and that build's failure is still the news."""
    finished = job.get("finishedAt")
    if job.get("state") not in ("done", "failed") or finished is None:
        return False
    saved = (job.get("savedResults") or {}).get(target)
    if isinstance(saved, dict) and saved.get("documentHash"):
        from cadgen.catalog import artifact_file_hash

        return artifact_file_hash(Path(target)) != saved["documentHash"]
    try:
        return os.stat(target).st_mtime > float(finished)
    except (OSError, TypeError, ValueError):
        return False
