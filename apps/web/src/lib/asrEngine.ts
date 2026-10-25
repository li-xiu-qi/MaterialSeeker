/**
 * transcripts.asr_engine 的取值。**记实际生效的那条，不是配置的那条。**
 *
 * 推理仓可能在云端失败后回退本地 FunASR（那时 ASR_PROVIDER 环境变量仍是
 * siliconflow），所以照配置写就会记成云端，事后按引擎统计对不上真实耗时与
 * 质量分布。推理仓不返回该字段时（旧版本服务）兜底为本地：那是该字段存在
 * 之前唯一在跑的路。
 *
 * 单列一个文件而不是塞进 ingestVideo：视频与音频两条入库链路都要用它，
 * 而 ingestAudio 不该为了一个映射去 import ingestVideo（那边挂着帧的三步
 * 处理，读代码时会被误导以为音频也走）。
 */

/** 推理仓回报的 asr_provider 值 → 引擎标识 */
export function asrEngineLabel(provider?: string): string {
  if (provider === 'siliconflow') return 'xingchen-asr-v3.2'
  if (provider === 'subtitle') return 'srt-subtitle'
  return 'funasr-paraformer-zh'
}
