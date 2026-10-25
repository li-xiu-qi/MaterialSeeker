import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

os.environ['MATERIALSEEKER_PROFILE'] = 'light'
SOURCE = Path(__file__).resolve().parents[1] / 'video_server.py'
spec = importlib.util.spec_from_file_location('video_server_light_test', SOURCE)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class VideoLightModeTest(unittest.TestCase):
    def tearDown(self):
        os.environ['MATERIALSEEKER_PROFILE'] = 'light'

    def test_local_provider_is_rejected_without_funasr(self):
        os.environ['ASR_PROVIDER'] = 'local'
        with self.assertRaises(HTTPException) as caught:
            server.transcribe('unused.wav')
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn('轻量模式', caught.exception.detail)

    def test_cloud_failure_does_not_attempt_local_fallback(self):
        os.environ['ASR_PROVIDER'] = 'siliconflow'
        with (
            patch.object(server, 'transcribe_cloud', side_effect=server.CloudASRError('cloud down')),
            patch.object(server, 'transcribe_local') as local,
        ):
            with self.assertRaises(HTTPException) as caught:
                server.transcribe('unused.wav')
            self.assertEqual(caught.exception.status_code, 503)
            local.assert_not_called()

    def test_cloud_path_remains_available(self):
        os.environ['ASR_PROVIDER'] = 'siliconflow'
        with patch.object(server, 'transcribe_cloud', return_value=[]):
            self.assertEqual(server.transcribe('unused.wav'), [])


if __name__ == '__main__':
    unittest.main()
