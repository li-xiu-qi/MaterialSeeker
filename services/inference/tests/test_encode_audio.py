"""音频向量编码的回归测试。

不加载真实模型：用一个记录调用参数的假 model 驱动 `encode`，断言音频走
`{"audio": path}` 的 dict 输入且不传 prompt。真实模型的行为由部署机上的
/health 与端到端检索覆盖，不在单元测试里拉 1.5G 权重。
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

os.environ['MATERIALSEEKER_PROFILE'] = 'standard'

SOURCE = Path(__file__).resolve().parents[1] / 'embedding_server.py'
spec = importlib.util.spec_from_file_location('embedding_server_audio_test', SOURCE)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeVec:
    """够 to_out 用的最小向量：切片、数乘、除法、迭代与求和。"""

    def __init__(self, values):
        self.values = list(values)

    def __getitem__(self, key):
        if isinstance(key, slice):
            return FakeVec(self.values[key])
        return self.values[key]

    def __mul__(self, other):
        if isinstance(other, FakeVec):
            return FakeVec([a * b for a, b in zip(self.values, other.values)])
        return FakeVec([x * other for x in self.values])

    __rmul__ = __mul__

    def __truediv__(self, other):
        return FakeVec([x / other for x in self.values])

    def __iter__(self):
        return iter(self.values)

    def sum(self):
        return sum(self.values)


class FakeModel:
    def __init__(self):
        self.calls = []

    def encode(self, inputs, prompt=None, **kwargs):
        self.calls.append({'inputs': inputs, 'prompt': prompt, 'kwargs': kwargs})
        if inputs and isinstance(inputs[0], dict) and 'audio' in inputs[0]:
            return [FakeVec([1.0] + [0.0] * 767)]
        return [FakeVec([0.0, 1.0] + [0.0] * 766)]


class EncodeAudioTests(unittest.TestCase):
    def setUp(self):
        # 别的用例会把 profile 改成 light 且不改回来，请求期才读环境变量。
        # 这里显式钉成 standard，否则音频用例会在 503 上假失败。
        self._prev_profile = os.environ.get('MATERIALSEEKER_PROFILE')
        os.environ['MATERIALSEEKER_PROFILE'] = 'standard'
        server._model = FakeModel()

    def tearDown(self):
        server._model = None
        if self._prev_profile is None:
            os.environ.pop('MATERIALSEEKER_PROFILE', None)
        else:
            os.environ['MATERIALSEEKER_PROFILE'] = self._prev_profile

    def test_audio_uses_dict_input_without_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            audio = Path(td) / 'sample.wav'
            audio.write_bytes(b'RIFFfake')

            request = server.EncodeRequest(
                inputs=[
                    {'modality': 'audio', 'path': str(audio)},
                    {'modality': 'text', 'text': '城市建筑'},
                ]
            )
            result = server.encode(request)

        self.assertEqual(len(result['embeddings']), 2)
        self.assertEqual(result['embeddings'][0]['dim'], 768)
        self.assertAlmostEqual(result['embeddings'][0]['vector'][0], 1.0, places=6)
        self.assertAlmostEqual(result['embeddings'][1]['vector'][1], 1.0, places=6)

        model = server._model
        audio_call = model.calls[-1]
        self.assertIsNone(audio_call['prompt'])
        self.assertIsInstance(audio_call['inputs'][0], dict)
        self.assertEqual(audio_call['inputs'][0]['audio'], str(audio))

    def test_missing_audio_path_is_rejected(self):
        request = server.EncodeRequest(inputs=[{'modality': 'audio', 'path': '/no/such/audio.wav'}])
        with self.assertRaises(HTTPException) as caught:
            server.encode(request)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn('audio not found', caught.exception.detail)

    def test_audio_input_requires_path_or_b64(self):
        request = server.EncodeRequest(inputs=[{'modality': 'audio'}])
        with self.assertRaises(HTTPException) as caught:
            server.encode(request)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn('path or b64', caught.exception.detail)


if __name__ == '__main__':
    unittest.main()
