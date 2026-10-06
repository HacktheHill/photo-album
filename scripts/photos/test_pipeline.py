#!/usr/bin/env python3
"""Build a tiny synthetic album and check the browser manifest's media routes."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402  (the script directory is the test import root)


class PipelineBuildTests(unittest.TestCase):
    def test_browser_manifest_uses_action_routes_without_private_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ("FullQuality", "QuickShare"):
                category = root / folder / "Opening Ceremony"
                category.mkdir(parents=True)
                Image.new("RGB", (64, 48), (120, 30, 40)).save(category / "IMG_0001.jpg", "JPEG")
            output = root / "assets"
            args = argparse.Namespace(
                source_root=str(root / "FullQuality"),
                quick_root=str(root / "QuickShare"),
                output_root=str(output),
                dry_run=False,
            )
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pipeline.build(args), 0)
            manifest = json.loads((output / "browser-manifest.json").read_text(encoding="utf-8"))
            [photo] = manifest["photos"]
            self.assertEqual(photo["thumbnail"]["url"], f"/?action=thumbnail&photo={photo['id']}")
            self.assertEqual(photo["preview"]["url"], f"/?action=preview&photo={photo['id']}")
            serialized = json.dumps(manifest)
            self.assertNotIn("/api/", serialized)
            self.assertNotIn("objectKey", serialized)
            self.assertNotIn(str(root), serialized)


if __name__ == "__main__":
    unittest.main()
