# API keys and runtime configuration

MaterialSeeker uses two cloud credentials: `ASR_CLOUD_KEY` for speech-to-text and `GLM_API_KEY` for image and video-frame captions. Local embeddings and local FunASR do not require these keys.

Only placeholders appear in this guide. Never commit real keys to the repository, issues, screenshots, or public logs.

## 1. Create the configuration file

From `services/inference`, copy the template:

```bash
cp .env.example .env
```

The `.env` file is already ignored by Git and is loaded by `start.sh`.

## 2. Get the two keys

| Variable | Purpose | Official links |
| --- | --- | --- |
| `ASR_CLOUD_KEY` | Cloud ASR for video and audio transcription through SiliconFlow | [SiliconFlow quickstart](https://docs.siliconflow.cn/cn/userguide/quickstart) and the [SiliconFlow console](https://cloud.siliconflow.cn/) |
| `GLM_API_KEY` | Visual captions for images and video frames through Zhipu | [API key management](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management) and the [Zhipu open platform](https://open.bigmodel.cn/) |

Use separate keys for development and production, and grant only the permissions each service needs.

## 3. What light mode requires

Light mode does not load local EmbeddingGemma 2 and does not fall back to local FunASR:

- Video and audio transcription requires `ASR_CLOUD_KEY`.
- AI captions for images or video frames require `GLM_API_KEY`.
- Text, basic image management, and UI checks do not require the 8281 service or these keys.

A minimal configuration looks like this:

```dotenv
MATERIALSEEKER_PROFILE=light
ASR_PROVIDER=siliconflow
ASR_CLOUD_KEY=your-siliconflow-api-key
GLM_API_KEY=your-bigmodel-api-key
FFMPEG_BIN=/path/to/ffmpeg
```

Keep the other defaults from `.env.example`:

| Variable | Default or purpose | When to change it |
| --- | --- | --- |
| `ASR_CLOUD_BASE_URL` | `https://api.siliconflow.cn` | Normally unchanged |
| `ASR_CLOUD_MODEL` | `XingChenAGI/XingChenASR-V3.2` | Only when selecting another ASR model |
| `OPENAI_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | Normally unchanged |
| `VISION_MODEL`, `VS_ANALYZE_MODEL` | Visual models used for image and frame captions | Adjust for currently available models; do not assume a model is permanently free or available |
| `FFMPEG_BIN` | Path to the FFmpeg executable | Point to the binary, not its containing directory |

### If you do not need frame captions

To run transcription, scene detection, and keyframe extraction without visual captioning, set:

```dotenv
MATERIALSEEKER_FRAME_CAPTION=0
```

Video ingestion will not call the visual model, so `GLM_API_KEY` can remain empty. Explicit AI captioning for images still requires that key.

## 4. When standard mode needs keys

Standard mode generates embeddings locally with EmbeddingGemma 2, so vector encoding itself does not call a cloud API:

```dotenv
MATERIALSEEKER_PROFILE=standard
MATERIALSEEKER_MODEL=/path/to/models/embeddinggemma-2
MATERIALSEEKER_DIM=768
```

For transcription, choose one of the following:

- `ASR_PROVIDER=siliconflow`: cloud ASR, requiring `ASR_CLOUD_KEY`.
- `ASR_PROVIDER=local`: local FunASR, requiring the local dependencies in `requirements-video.txt` instead of an ASR cloud key.

Frame captions follow the same rules as above. After changing the embedding model or dimension, existing vectors may be incompatible and must be rebuilt explicitly.

## 5. Start and verify

From `services/inference`:

```bash
bash start.sh
curl http://127.0.0.1:8281/health
```

Use the same profile for the web app:

```bash
cd apps/web
MATERIALSEEKER_PROFILE=light npm run dev
```

If inference runs on another host, configure the web-side addresses:

```dotenv
MATERIALSEEKER_INFERENCE_URL=http://127.0.0.1:8280
MATERIALSEEKER_VIDEO_URL=http://127.0.0.1:8281
```

Replace these examples with your actual deployment addresses. Do not publish private network addresses in public documentation.

## 6. Troubleshooting

| Symptom | Check first |
| --- | --- |
| `ASR_CLOUD_KEY 未配置` | Whether `.env` is in `services/inference`, whether `start.sh` loaded it, and whether the variable name is correct |
| 401 or 403 | Whether the key is valid, unexpired, and allowed to use the selected model |
| 429 | Rate limiting or insufficient quota; retry later and inspect the account balance |
| 503 | Whether the cloud provider is unavailable; light mode does not fall back to local FunASR |
| `ffmpeg not found` | Whether `FFMPEG_BIN` points to the executable instead of a directory |
| Transcript exists but no frame captions | Whether `GLM_API_KEY` is configured and `MATERIALSEEKER_FRAME_CAPTION` is not `0` |

## 7. Optional Alibaba Cloud DashScope configuration

Alibaba Cloud offers some of the models MaterialSeeker needs, but the three capabilities do not share one drop-in API shape.

### Image and frame captions: ready to configure

The current code accepts `DASHSCOPE_API_KEY`. When set, it takes precedence over `GLM_API_KEY`, so configure only one of them:

```dotenv
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_API_KEY=your-dashscope-api-key
VISION_MODEL=qwen3-vl-plus
VS_ANALYZE_MODEL=qwen3-vl-plus
```

The OpenAI-compatible endpoint supports the `image_url` and Base64 Data URL forms used by MaterialSeeker. See the official [vision guide](https://help.aliyun.com/zh/model-studio/vision) and [API key instructions](https://help.aliyun.com/zh/model-studio/get-api-key).

For Beijing workspaces, you can also use `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` and replace `{WorkspaceId}` with your real workspace ID. The older `dashscope.aliyuncs.com` domain remains available.

### Paraformer transcription: a dedicated provider is required

The asynchronous Paraformer endpoint is `POST /api/v1/services/audio/asr/transcription`, with models such as `paraformer-v2`. DashScope itself is a public cloud service, and the audio must also be downloadable by DashScope over a public HTTP/HTTPS URL:

- `localhost`, `127.0.0.1`, private network addresses, and local `file://` paths do not work with this endpoint.
- **OSS is not mandatory.** Any publicly accessible HTTP/HTTPS hosting service works. OSS is simply the recommended stable storage option. Temporary signed URLs are useful for tests; production should use stable storage and a long-lived accessible address.
- The API accepts audio URLs in `file_urls`, not the local multipart upload used by the current provider. After submission, you must poll the task and download the JSON result from `transcription_url`.

Changing `ASR_CLOUD_BASE_URL` alone is not enough. A proper adapter must handle file hosting, asynchronous polling, and result download. If local files must be processed directly, Alibaba Cloud also provides a real-time SDK / WebSocket path, but that is a different integration rather than a drop-in replacement for the current HTTP upload API. See the [recorded speech recognition guide](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api).

### Embeddings: available, but not interchangeable

`qwen3-vl-embedding` supports text, images, and video, including 768 dimensions, through the dedicated `/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding` endpoint. It does not support the OpenAI-compatible endpoint.

`qwen3.7-text-embedding` and `text-embedding-v4` support OpenAI-compatible calls, but they cover text only and cannot replace the unified text, image, and frame vectors used by MaterialSeeker.

Even at the same 768 dimensions, vectors from another model are not guaranteed to share the EmbeddingGemma 2 vector space. Switching models requires a full rebuild with one model, not mixing new vectors into an existing library. See the official [embedding guide](https://help.aliyun.com/zh/model-studio/embedding).

## 8. Credential safety

- Do not commit `.env`, and never put real keys in README files, test fixtures, or screenshots.
- Do not paste full keys into public logs, issues, pull requests, or chat messages.
- If a key may have leaked, revoke it in the provider console, create a replacement, and update your local configuration.
- Review usage and spending regularly instead of running experiments against production credentials.
