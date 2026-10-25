import importlib.util
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ENV = {
    'MATERIALSEEKER_PROFILE': 'light',
    'DASHSCOPE_API_KEY': 'dashscope-key',
    'GLM_API_KEY': 'zhipu-key',
    'OPENAI_API_BASE': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'VS_ANALYZE_MODEL': 'qwen3-vl-plus',
    'VISION_MODEL': 'qwen3-vl-plus',
}


def load_server(filename: str):
    source = ROOT / filename
    spec = importlib.util.spec_from_file_location(f'{filename[:-3]}_provider_test', source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_response():
    content = '{"title":"示例","description":"描述","tags":["标签"]}'
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


class CaptionProviderTests(unittest.TestCase):
    def test_video_analyze_accepts_dashscope_credentials(self):
        with patch.dict(os.environ, ENV, clear=False), patch('openai.OpenAI') as client_class:
            server = load_server('video_server.py')
            client_class.return_value.chat.completions.create.return_value = model_response()
            result = server.analyze(server.AnalyzeRequest(image_base64='aGVsbG8='))

        self.assertEqual(result['title'], '示例')
        kwargs = client_class.call_args.kwargs
        self.assertEqual(kwargs['api_key'], 'dashscope-key')
        self.assertEqual(kwargs['base_url'], 'https://dashscope.aliyuncs.com/compatible-mode/v1')
        create_kwargs = client_class.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(create_kwargs['model'], 'qwen3-vl-plus')

    def test_embedding_caption_accepts_dashscope_credentials(self):
        with patch.dict(os.environ, ENV, clear=False), patch('openai.OpenAI') as client_class:
            server = load_server('embedding_server.py')
            client_class.return_value.chat.completions.create.return_value = model_response()
            result = server.caption(server.CaptionRequest(image_b64='aGVsbG8='))

        self.assertEqual(result['title'], '示例')
        kwargs = client_class.call_args.kwargs
        self.assertEqual(kwargs['api_key'], 'dashscope-key')
        self.assertEqual(kwargs['base_url'], 'https://dashscope.aliyuncs.com/compatible-mode/v1')
        create_kwargs = client_class.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(create_kwargs['model'], 'qwen3-vl-plus')


if __name__ == '__main__':
    unittest.main()
