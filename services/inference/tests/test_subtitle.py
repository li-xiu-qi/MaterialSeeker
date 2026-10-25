"""现成 SRT 字幕复用的回归测试。"""
import tempfile
import unittest
from pathlib import Path

from video_server import parse_srt


class SubtitleTests(unittest.TestCase):
    def test_parse_srt_keeps_text_and_millisecond_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.srt"
            path.write_text(
                "1\n00:00:00,520 --> 00:00:03,900\n第一句 测试\n\n"
                "2\n00:00:03,900 --> 00:00:06,320\n第二句\n换行也保留\n",
                encoding="utf-8",
            )
            rows = parse_srt(str(path))

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["sentence"], "第一句 测试")
        self.assertEqual(rows[0]["start_ms"], 520)
        self.assertEqual(rows[0]["end_ms"], 3900)
        self.assertEqual(rows[1]["sentence"], "第二句 换行也保留")
        self.assertIsNone(rows[1]["spk_id"])

    def test_blocks_without_timestamp_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.srt"
            path.write_text("这不是字幕块\n\n1\n00:00:01,000 --> 00:00:02,000\n有效句", encoding="utf-8")
            rows = parse_srt(str(path))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sentence"], "有效句")


if __name__ == "__main__":
    unittest.main()
