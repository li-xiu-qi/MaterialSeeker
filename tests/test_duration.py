"""视频真实时长的回归测试。"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

os.environ["MATERIALSEEKER_PROFILE"] = "light"
SOURCE = Path(__file__).resolve().parents[1] / "video_server.py"
spec = importlib.util.spec_from_file_location("video_server_duration_test", SOURCE)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class DurationTests(unittest.TestCase):
    def test_ffmpeg_lookup_uses_native_executable_path(self) -> None:
        native_path = r"C:\Tools\ffmpeg.EXE"
        with (
            patch.object(server, "FFMPEG_CANDIDATES", [""]),
            patch.object(server.shutil, "which", return_value=native_path) as which,
        ):
            self.assertEqual(server.ffmpeg_bin(), native_path)
        which.assert_called_once_with("ffmpeg")

    @patch.object(server, "ffmpeg_bin", return_value="ffmpeg")
    @patch.object(server.subprocess, "run")
    def test_probe_reads_container_header_without_decoding(self, run, _ffmpeg) -> None:
        run.return_value = SimpleNamespace(stderr="Duration: 00:04:57.54, start: 0.000000")

        self.assertEqual(server.probe_duration_ms("source.mp4"), 297540)
        command = run.call_args.args[0]
        self.assertNotIn("-f", command)
        self.assertNotIn("null", command)
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_process_does_not_mistake_last_scene_for_duration(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            video = Path(td) / "source.mp4"
            video.write_bytes(b"test double")
            subtitle = Path(td) / "source.srt"
            subtitle.write_text("", encoding="utf-8")
            with (
                patch.object(server, "_ensure_decodable", return_value=(str(video), None)),
                patch.object(server, "probe_duration_ms", return_value=297541),
                patch.object(
                    server,
                    "detect_scenes",
                    return_value=[{"start_ms": 0, "end_ms": 10000}],
                ),
                patch.object(server, "extract_frame_at", side_effect=HTTPException(400, "skip")),
                patch.object(server, "parse_srt", return_value=[]),
            ):
                result = server.process(
                    server.ProcessRequest(
                        video_path=str(video),
                        subtitle_path=str(subtitle),
                        frames_out_dir=td,
                    )
                )

        self.assertEqual(result["scenes"][-1]["end_ms"], 10000)
        self.assertEqual(result["duration_ms"], 297541)


if __name__ == "__main__":
    unittest.main()
