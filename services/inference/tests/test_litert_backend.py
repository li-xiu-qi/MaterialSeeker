"""LiteRT-LM 后端的回归测试。

不加载真实 .litertlm 模型：用假 litert_lm 模块驱动 `LiteRTEmbeddingModel`，
断言三件事——文本带 task-prefix、图加文组合按多内容 request 进入、音频走
AudioFile。真实 NPU 行为由部署机上的 /health 与端到端检索覆盖。
"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'embedding_server.py'
spec = importlib.util.spec_from_file_location('embedding_server_litert_test', SOURCE)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeContent:
    @staticmethod
    def Text(text):
        return SimpleNamespace(kind='text', text=text)

    @staticmethod
    def ImageBytes(data):
        return SimpleNamespace(kind='image_bytes', data=data)

    @staticmethod
    def AudioFile(path):
        return SimpleNamespace(kind='audio_file', path=path)


class FakeInterfaces:
    class CPU:
        def __init__(self, thread_count=None):
            self.thread_count = thread_count

    class GPU:
        pass

    class NPU:
        def __init__(self, litert_dispatch_lib_dir=None):
            self.litert_dispatch_lib_dir = litert_dispatch_lib_dir


class FakeEmbeddingEngine:
    def __init__(self, model_path, backend, vision_backend, audio_backend):
        self.model_path = model_path
        self.backend = backend
        self.vision_backend = vision_backend
        self.audio_backend = audio_backend
        self.batch_calls = []
        self.single_calls = []

    def compute_embedding(self, content, options=None):
        self.single_calls.append(content)
        return SimpleNamespace(embedding=[0.0] * 767 + [1.0])

    def compute_embedding_batch(self, requests, options=None):
        self.batch_calls.append(requests)
        return [SimpleNamespace(embedding=[1.0] + [0.0] * 767) for _ in requests]


class LiteRTBackendTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(
            os.environ,
            {
                'MATERIALSEEKER_EMBEDDING_ENGINE': 'litert',
                'MATERIALSEEKER_LITERT_MODEL': '/fake/model.litertlm',
                'MATERIALSEEKER_LITERT_BACKEND': 'cpu',
                'MATERIALSEEKER_LITERT_VISION_BACKEND': 'cpu',
                'MATERIALSEEKER_LITERT_AUDIO_BACKEND': 'cpu',
                'MATERIALSEEKER_LITERT_TEXT_PREFIX_MODE': 'prepend',
                'MATERIALSEEKER_PROFILE': 'standard',
            },
            clear=False,
        )
        self._env.start()
        # LITERT_MODEL 在模块导入时求值，测试里显式覆盖常量，避免依赖环境注入时序。
        self._model_path = patch.object(server, 'LITERT_MODEL', '/fake/model.litertlm')
        self._model_path.start()
        self._litert = patch.dict(
            sys.modules,
            {
                'litert_lm': SimpleNamespace(
                    Content=FakeContent,
                    EmbeddingOptions=lambda **kwargs: SimpleNamespace(**kwargs),
                    EmbeddingEngine=FakeEmbeddingEngine,
                    interfaces=FakeInterfaces,
                )
            },
            clear=False,
        )
        self._litert.start()

    def tearDown(self):
        self._model_path.stop()
        self._litert.stop()
        self._env.stop()

    def test_text_requests_carry_task_prefix(self):
        model = server.LiteRTEmbeddingModel()
        vectors = model.encode(
            ['城市建筑', '海边日落'],
            prompt=server.DEFAULT_QUERY_INSTRUCTION,
        )

        self.assertEqual(len(vectors), 2)
        requests = model._engine.batch_calls[-1]
        self.assertEqual(
            [item.text for item in requests],
            [
                server.DEFAULT_QUERY_INSTRUCTION + '城市建筑',
                server.DEFAULT_QUERY_INSTRUCTION + '海边日落',
            ],
        )

    def test_image_text_combo_is_one_multimodal_request(self):
        from PIL import Image

        model = server.LiteRTEmbeddingModel()
        image = Image.new('RGB', (2, 2), color='red')
        vectors = model.encode([{'image': image, 'text': '红色方块'}])

        self.assertEqual(len(vectors), 1)
        request = model._engine.batch_calls[-1][0]
        self.assertIsInstance(request, list)
        self.assertEqual([item.kind for item in request], ['image_bytes', 'text'])
        self.assertEqual(request[1].text, '红色方块')
        self.assertTrue(request[0].data.startswith(b'\x89PNG'))

    def test_audio_uses_audio_file_content(self):
        model = server.LiteRTEmbeddingModel()
        vectors = model.encode([{'audio': '/fake/sample.wav'}])

        self.assertEqual(len(vectors), 1)
        request = model._engine.batch_calls[-1][0]
        self.assertEqual(request.kind, 'audio_file')
        self.assertEqual(request.path, '/fake/sample.wav')

    def test_health_reports_litert_backends(self):
        model = server.LiteRTEmbeddingModel()
        server._model = model
        try:
            payload = server.health()
        finally:
            server._model = None

        self.assertTrue(payload['ok'])
        self.assertEqual(payload['engine'], 'litert')
        self.assertEqual(payload['model'], '/fake/model.litertlm')
        self.assertEqual(
            payload['backends'],
            {'text': 'cpu', 'vision': 'cpu', 'audio': 'cpu'},
        )
        self.assertEqual(payload['raw_dim'], 768)

    def test_npu_failure_falls_back_to_cpu(self):
        class NpuUnavailableEngine(FakeEmbeddingEngine):
            def __init__(self, model_path, backend, vision_backend, audio_backend):
                if isinstance(backend, FakeInterfaces.NPU):
                    raise RuntimeError('NPU unavailable')
                super().__init__(model_path, backend, vision_backend, audio_backend)

        with patch.dict(os.environ, {'MATERIALSEEKER_LITERT_BACKEND': 'npu'}), patch.dict(
            sys.modules,
            {
                'litert_lm': SimpleNamespace(
                    Content=FakeContent,
                    EmbeddingOptions=lambda **kwargs: SimpleNamespace(**kwargs),
                    EmbeddingEngine=NpuUnavailableEngine,
                    interfaces=FakeInterfaces,
                )
            },
        ):
            model = server.LiteRTEmbeddingModel()

        self.assertIn('litert:cpu/cpu/cpu', model.device)
        self.assertIn('requested npu/cpu/cpu', model.device)
        self.assertEqual(model.get_sentence_embedding_dimension(), 768)


if __name__ == '__main__':
    unittest.main()
