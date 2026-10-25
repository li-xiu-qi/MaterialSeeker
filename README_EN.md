<div align="center">
  <img src="docs/assets/brand/logo.svg" alt="MaterialSeeker logo" width="96">
  <h1>MaterialSeeker</h1>
  <p>A local-first multimodal content search workbench</p>
  <p><a href="README.md">中文</a> · <a href="README_EN.md">English</a></p>
</div>

## What is MaterialSeeker?

MaterialSeeker turns videos, images, audio files, and text notes into one searchable library. Instead of indexing only filenames, it makes speech, scene frames, keyframe captions, and written content searchable.

You no longer need to scrub through an entire timeline or remember where a file is stored. A phrase, a concept, or a visual memory is enough to locate the source and the moment it happened. Your media and indexes stay on your machine, while models and providers can be selected for your deployment.

## What can you do with it?

- **Learn from courses**: search for concepts such as storyboarding or rendering, jump to the exact sentence, and see the matching slide or software view.
- **Organize video assets**: extract scene keyframes and find people, places, objects, and visual styles through frame descriptions.
- **Review meetings and interviews**: find the original sentence in a transcript and replay its context instead of reading an isolated text fragment.
- **Manage images and notes**: organize assets with tags, captions, and keywords. The standard profile also adds vector-based semantic retrieval.

## Core capabilities

| Capability | What you get |
| --- | --- |
| Multimodal ingestion | Videos, images, audio, and text in one library, organized into separate collections |
| Transcription and seeking | Chinese speech-to-text, sentence-level timestamps, and click-to-play navigation |
| Scene and visual understanding | Automatic scene detection, keyframe extraction, and AI-generated frame captions |
| Keyword and semantic search | SQLite FTS5 keyword search, with optional EmbeddingGemma 2 vector retrieval in the standard profile |
| Asset management | Edit titles, captions, and tags; bulk delete, copy, move, and export assets |
| Flexible deployment | A light profile without GPU requirements and a standard profile with local vectors, connected over HTTP |

## UI preview

**Unified search: course frames and transcript hits in one result set**

![A storyboard query returning a course keyframe and transcript chunks](docs/assets/demo/search-storyboard.png)

**Video details: playback, transcript, and sentence-level seeking together**

![A course storyboard, transcript, and sentence-level playback position](docs/assets/demo/course-detail.png)

**Keyframes: scene images with generated descriptions**

![Scene keyframes and captions from Big Buck Bunny](docs/assets/demo/keyframe-grid.png)

The demo videos come from public Bilibili pages and are not included in the repository. See [demo media sources and licenses](docs/demo-media.md).

## Deployment profiles

| Capability | Light `light` | Standard `standard` |
| --- | --- | --- |
| Speech-to-text and sentence timestamps | Supported through cloud ASR | Cloud-first, with local FunASR fallback |
| Scene detection, keyframes, and frame captions | Supported | Supported |
| Keyword search | Supported | Supported |
| Vector semantic search | Not included | Included |
| Local model dependencies | No EmbeddingGemma 2 or FunASR | EmbeddingGemma 2 required; FunASR optional |
| Inference services | 8281 only | 8280 and 8281 |

The default is `standard` when no profile is configured. Assets added in light mode do not receive vectors. After switching to standard, you can backfill them explicitly instead of rebuilding the entire library automatically.

## Quick start

You need Node.js, Python, and FFmpeg. Clone the repository first:

```bash
git clone https://github.com/li-xiu-qi/MaterialSeeker.git
cd MaterialSeeker
```

### Start the web app

From the repository root, enter `apps/web`, install dependencies, and start the app:

```bash
cd apps/web
npm install

# Linux / macOS
MATERIALSEEKER_PROFILE=light npm run dev
```

Windows PowerShell:

```powershell
$env:MATERIALSEEKER_PROFILE = "light"
$env:MATERIALSEEKER_DATA_DIR = "C:/path/to/materialseeker-data"
npm run dev
```

Open `http://localhost:9280`. You do not need a Python service for text, images, or UI checks.

### Video and audio processing

Video and audio ingestion also requires the 8281 service. These commands use Linux / macOS. See the [inference service guide](services/inference/README.md) for the equivalent Windows setup.

```bash
# In a separate terminal, from the repository root
cd services/inference
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-light.txt
cp .env.example .env
# Edit .env: light profile, FFMPEG_BIN, ASR_CLOUD_KEY, and GLM_API_KEY
bash start.sh
```

For vector-based semantic retrieval, use `standard` and configure the model and the two separate Python environments described in the same guide.

## Related projects

- [HearSight](https://github.com/li-xiu-qi/HearSight): the reference for audio and video processing, content analysis, and chunk-based indexing.
- [SmartImager](https://github.com/li-xiu-qi/Smartlmager): the reference for image search and asset management.
- [Inference service guide](services/inference/README.md): deployment profiles, HTTP endpoints, models, and service configuration.

MaterialSeeker evolves independently from these projects and is not affiliated with them.

## License

Apache-2.0. See [LICENSE](LICENSE).
