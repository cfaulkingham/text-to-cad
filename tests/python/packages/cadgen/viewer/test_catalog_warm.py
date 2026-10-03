"""A build's saved files have their catalog rows computed as the save is announced, off the
request threads, so the catalog read that follows the build finds them (``cadgen.viewer.warm``)."""
from __future__ import annotations

import hashlib
import os
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from cadgen import catalog
from cadgen.viewer import scanner, warm
from cadgen.viewer.http_app import create_cad_app
from tests.python.support.store_fixtures import seed_result
from tests.python.support.tmp_root import generated_cad_directory

# A guard against a hang, never a measurement: every wait below is for a condition.
HANG = 60.0


class _Watched:
    """A single-flight event that also says when someone starts waiting on it."""

    def __init__(self, inner: threading.Event, waiting: threading.Event) -> None:
        self.inner, self.waiting = inner, waiting

    def wait(self, timeout=None):
        self.waiting.set()
        return self.inner.wait(timeout)


def _watch_flight(flights: dict, lock, match, waiting: threading.Event) -> None:
    with lock:
        (key,) = [key for key in flights if match(key)]
        flights[key] = _Watched(flights[key], waiting)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CatalogWarmTests(unittest.TestCase):
    def setUp(self):
        temporary = generated_cad_directory(prefix="catalog-warm-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / "project"
        self.root.mkdir()
        self.store = str(Path(temporary.name).resolve() / "store")
        env = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": self.store})
        env.start()
        self.addCleanup(env.stop)
        self.part = self.root / "part.step"
        self.part.write_bytes(b"first version\n")
        self.app = create_cad_app(root=str(self.root), host="127.0.0.1", port=0)
        # A read answers with the row it names; the rest of the catalog is not this test's.
        hydration = mock.patch.object(self.app.backend, "_start_catalog_hydration")
        hydration.start()
        self.addCleanup(hydration.stop)

    def replace(self, data: bytes) -> None:
        staged = self.root / ".part.step.staged"
        staged.write_bytes(data)
        os.replace(staged, self.part)

    @contextmanager
    def ledger(self, tree: str, phase: str = "STEP saved"):
        """The daemon's ledger, listing a build of part.step that has saved it."""
        output = str(self.part)
        job = {"id": "epoch:job-1", "epoch": "epoch", "sequence": 1, "tool": "run", "storeRoot": self.store,
               "outputs": [output], "state": "building", "phase": phase,
               "savedResults": {output: {"tree": tree, "documentHash": _sha(self.part), "output": output}}}
        with mock.patch("cadgen.daemon.client.watch_jobs", return_value={"jobsCursor": "epoch:2", "jobs": [job]}):
            yield

    def entry(self) -> dict:
        return self.app.backend.catalog_entry_for_file_ref(self.app.read_catalog("part.step"), "part.step")

    def test_a_save_the_feed_lists_is_warmed_on_a_thread_of_its_own_and_the_read_finds_it(self):
        tree = seed_result(self.part, {"label": "saved"})
        with self.ledger(tree):
            self.assertEqual(self.app.build_status("part.step", after="epoch:1")["phase"], "STEP saved")
        self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
        with mock.patch.object(catalog, "open_shared_for_read", side_effect=AssertionError("read the file again")), \
                mock.patch.object(scanner, "_build_step_entry", side_effect=AssertionError("built the row again")):
            entry = self.entry()
        # The row is the file's: its digest, and the tree its bytes name.
        self.assertEqual((entry["documentHash"], entry["hash"]), (_sha(self.part), tree))

    def test_the_feed_answers_before_the_warm_and_a_version_is_warmed_once(self):
        tree = seed_result(self.part, {"label": "saved"})
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        warmed = []

        def warm_row(root, path):
            warmed.append((threading.current_thread().name, os.path.basename(path)))
            entered.set()
            release.wait(HANG)
            finished.set()

        with mock.patch.object(warm, "warm_catalog_entry", warm_row), self.ledger(tree):
            self.app.build_status("part.step", after="epoch:1")
            self.assertFalse(finished.is_set())  # answered while its save waits to be warmed
            self.assertTrue(entered.wait(HANG))
            self.app.build_status("part.step", after="epoch:1")  # the feed lists the save again
            release.set()
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
            self.app.build_status("part.step", after="epoch:1")
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
            self.assertEqual(warmed, [("cadgen-viewer-catalog-warm", "part.step")])
            self.replace(b"second version\n")
            self.app.build_status("part.step", after="epoch:1")
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
        self.assertEqual(len(warmed), 2)

    def test_a_catalog_read_joins_the_row_its_warm_is_building(self):
        tree = seed_result(self.part, {"label": "saved"})
        building, release, waiting = threading.Event(), threading.Event(), threading.Event()
        builders, read = [], []
        build = scanner._build_step_entry

        def held_build(*args, **kwargs):
            builders.append(threading.current_thread().name)
            building.set()
            release.wait(HANG)
            return build(*args, **kwargs)

        with mock.patch.object(scanner, "_build_step_entry", held_build):
            self.app.catalog_warm.saved({str(self.part): tree})
            self.assertTrue(building.wait(HANG))
            _watch_flight(scanner._STEP_ENTRY_FLIGHTS, scanner._STEP_ENTRY_CACHE_LOCK,
                          lambda key: key[3] == str(self.part), waiting)
            reader = threading.Thread(target=lambda: read.append(self.entry()))
            reader.start()
            self.assertTrue(waiting.wait(HANG))
            release.set()
            reader.join(HANG)
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
        self.assertEqual(builders, ["cadgen-viewer-catalog-warm"])
        self.assertEqual(read[0]["hash"], tree)

    def test_readers_of_one_file_version_share_one_read(self):
        opened, release, waiting = threading.Event(), threading.Event(), threading.Event()
        reads, answers = [], []
        real_open = catalog.open_shared_for_read

        def held_open(path):
            reads.append(path)
            opened.set()
            release.wait(HANG)
            return real_open(path)

        stat = self.part.stat()
        flight = (str(self.part), stat.st_mtime_ns, stat.st_size)
        with mock.patch.object(catalog, "open_shared_for_read", held_open):
            readers = [threading.Thread(target=lambda: answers.append(catalog.artifact_file_hash(self.part))) for _ in range(2)]
            readers[0].start()
            self.assertTrue(opened.wait(HANG))
            _watch_flight(catalog._ARTIFACT_HASH_FLIGHTS, catalog._ARTIFACT_HASH_MEMO_LOCK, lambda key: key == flight, waiting)
            readers[1].start()
            self.assertTrue(waiting.wait(HANG))
            release.set()
            for reader in readers:
                reader.join(HANG)
        self.assertEqual(len(reads), 1)
        self.assertEqual(answers, [_sha(self.part)] * 2)

    def test_a_file_replaced_during_its_warm_is_read_afresh_and_never_served_stale(self):
        first = seed_result(self.part, {"label": "first"})
        held, release = threading.Event(), threading.Event()
        real_open = catalog.open_shared_for_read
        opens = []

        def holding_open(path):
            handle = real_open(path)
            opens.append(path)
            if len(opens) == 1:  # the warm's read, of the first version
                held.set()
                release.wait(HANG)
            return handle

        with mock.patch.object(catalog, "open_shared_for_read", holding_open):
            self.app.catalog_warm.saved({str(self.part): first})
            self.assertTrue(held.wait(HANG))
            self.replace(b"second version\n")
            second = seed_result(self.part, {"label": "second"})
            # The read neither waits for the warm nor takes its version.
            self.assertEqual((self.entry()["documentHash"], self.entry()["hash"]), (_sha(self.part), second))
            release.set()
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
        # Nor does what the warm read of the first version answer for the second.
        self.assertEqual((self.entry()["documentHash"], self.entry()["hash"]), (_sha(self.part), second))
        self.assertNotEqual(first, second)

    def test_saves_waiting_to_be_warmed_are_bounded(self):
        held, release = threading.Event(), threading.Event()
        warmed = []

        def warm_row(root, path):
            warmed.append(os.path.basename(path))
            held.set()
            release.wait(HANG)

        names = [f"part{index:02d}.step" for index in range(warm.WARM_PENDING_LIMIT + 4)]
        for name in names:
            (self.root / name).write_bytes(name.encode("ascii"))
        with mock.patch.object(warm, "warm_catalog_entry", warm_row):
            self.app.catalog_warm.saved({str(self.root / names[0]): ""})
            self.assertTrue(held.wait(HANG))
            self.app.catalog_warm.saved({str(self.root / name): "" for name in names[1:]})
            release.set()
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))
        # The one being warmed, then as many as wait at once; the rest are left to the reads.
        self.assertEqual(warmed, names[: 1 + warm.WARM_PENDING_LIMIT])

    def test_only_files_the_catalog_lists_are_warmed(self):
        hidden = self.root / ".hidden" / "part.step"
        hidden.parent.mkdir()
        hidden.write_bytes(b"hidden\n")
        outside = self.root.parent / "outside.step"
        outside.write_bytes(b"outside\n")
        with mock.patch.object(warm, "warm_catalog_entry", side_effect=AssertionError("warmed an unlisted file")):
            self.app.catalog_warm.saved({str(hidden): "", str(outside): "", str(self.root / "gone.step"): ""})
            self.assertTrue(self.app.catalog_warm.wait_settled(HANG))


if __name__ == "__main__":
    unittest.main()
