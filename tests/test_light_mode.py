import importlib.util
import os
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException

# 证明轻量模式不依赖 torch：若模块顶层重新引入 torch，本测试会在导入时失败。
sys.modules['torch'] = None
os.environ['MATERIALSEEKER_PROFILE'] = 'light'

SOURCE = Path(__file__).resolve().parents[1] / 'embedding_server.py'
spec = importlib.util.spec_from_file_location('embedding_server_light_test', SOURCE)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class LightModeTest(unittest.TestCase):
    def tearDown(self):
        os.environ['MATERIALSEEKER_PROFILE'] = 'light'

    def test_light_health_does_not_load_model(self):
        result = server.health()
        self.assertTrue(result['ok'])
        self.assertEqual(result['profile'], 'light')
        self.assertFalse(result['embedding_enabled'])
        self.assertIsNone(result['model'])
        self.assertIsNone(server._model)

    def test_encode_is_explicitly_unavailable(self):
        request = server.EncodeRequest(inputs=[])
        with self.assertRaises(HTTPException) as caught:
            server.encode(request)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn('disabled', caught.exception.detail)

    def test_standard_flag_is_preserved_without_loading_model(self):
        os.environ['MATERIALSEEKER_PROFILE'] = 'standard'
        self.assertTrue(server.embedding_enabled())
        self.assertIsNone(server._model)

    def test_invalid_profile_fails_closed(self):
        os.environ['MATERIALSEEKER_PROFILE'] = 'invalid'
        with self.assertRaises(RuntimeError):
            server.embedding_enabled()


if __name__ == '__main__':
    unittest.main()
