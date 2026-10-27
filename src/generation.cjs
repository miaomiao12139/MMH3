const profiles = require('./generation-profiles.json');
const { randomInt } = require('node:crypto');
const styles = [
  ['art_is_explosion', '艺术爆炸'], ['blooming_flowers', '繁花盛开'],
  ['bullet_time', '子弹时间'], ['dark_magic', '暗黑魔法'],
  ['fire_breath', '火焰吐息'], ['four_seasons', '四季变换'],
  ['kiss_camera', '亲吻镜头'], ['spiral_ascent', '螺旋上升'],
  ['storm_magic', '风暴魔法'], ['truman_show', '楚门世界'],
].map(([id, name]) => ({ id, name, file: `minimaxh3_${id}.safetensors` }));

function applyGenerationSettings(graph, workflowId, settings = {}) {
  const mode = settings.samplingMode || 'quality';
  if (!['quality', 'turbo4', 'turbo8'].includes(mode)) throw new Error('生成模式不正确');
  const reference = ['r2v', 'multiframe', 'control'].includes(workflowId);
  if (mode === 'turbo8' && reference) throw new Error('当前模式支持标准质量或四步加速');
  if (mode === 'turbo4' && !reference && settings.resolution === 'ultra') throw new Error('四步加速模型适用于 768p，请选择标准或高清分辨率');
  const lora = reference ? 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'
    : mode === 'turbo4' ? 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors'
      : 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors';
  for (const node of Object.values(graph)) {
    if (node.class_type === 'LoraLoaderModelOnly' && /minimax_h3_.*turbo/.test(node.inputs.lora_name || '')) node.inputs.lora_name = lora;
    if (node.class_type === 'ComfySwitchNode') {
      const onTrue = graph[node.inputs.on_true?.[0]];
      if (onTrue?.class_type === 'LoraLoaderModelOnly' && /minimax_h3_.*turbo/.test(onTrue.inputs.lora_name || '')) node.inputs.switch = mode !== 'quality';
      if (onTrue?.class_type === 'PrimitiveInt' && ['4', '8'].includes(String(onTrue.inputs.value))) {
        node.inputs.switch = mode !== 'quality';
        onTrue.inputs.value = mode === 'turbo8' ? 8 : 4;
      }
    }
    if (node.class_type === 'MiniMaxH3FunControlNetApply') node.inputs.strength = Math.max(0, Math.min(2, Number(settings.controlStrength ?? 1)));
  }
}

function styledPrompt(prompt, styleId) {
  const style = styles.find(s => s.id === styleId);
  return style ? `embedding:${style.file} ${prompt}` : String(prompt || '');
}

function outputSize(settings = {}) {
  const ratio = String(settings.aspectRatio || '16:9');
  const aspect = ratio.startsWith('9:16') ? 'portrait' : ratio.startsWith('1:1') ? 'square' : 'landscape';
  return profiles[aspect][settings.resolution || 'standard'] || profiles[aspect].standard;
}

function bindGenerationInputs(graph, workflowId, uploaded, settings = {}) {
  const h3Entry = Object.entries(graph).find(([, n]) => ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'].includes(n.class_type));
  if (!h3Entry) throw new Error('工作流缺少视频生成节点');
  const [h3Id, h3] = h3Entry;
  const images = Object.entries(graph).filter(([, n]) => n.class_type === 'LoadImage');
  if (workflowId === 'i2v' || workflowId === 'continuation') {
    delete h3.inputs.last_frame;
    uploaded.forEach(({ filename }, index) => {
      const id = images[index]?.[0] || `studio_image_${index}`;
      graph[id] = { class_type: 'LoadImage', inputs: { image: filename } };
      h3.inputs[index === 0 ? 'first_frame' : 'last_frame'] = [id, 0];
    });
  } else if (workflowId === 'multiframe') {
    for (const key of Object.keys(h3.inputs).filter(k => k.startsWith('ref_images.'))) delete h3.inputs[key];
    let conditioning = [h3Id, 0];
    uploaded.forEach(({ filename }, index) => {
      const image = `studio_image_${index}`;
      const guide = `studio_guide_${index}`;
      graph[image] = { class_type: 'LoadImage', inputs: { image: filename } };
      const seconds = Number(settings.frameTimes?.[index] ?? [0, 1.5, 3, 4.5][index]);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds >= Number(settings.duration || 5)) throw new Error(`第 ${index + 1} 帧的时间必须小于视频时长`);
      graph[guide] = { class_type: 'MiniMaxH3AddGuide', inputs: { positive: conditioning, latent: [h3Id, 1], vae: h3.inputs.vae, audio_vae: h3.inputs.audio_vae, image: [image, 0], frame_idx: Math.round(seconds * 24) } };
      conditioning = [guide, 0];
    });
    for (const node of Object.values(graph)) if (node.class_type === 'BasicGuider') node.inputs.conditioning = conditioning;
  } else if (workflowId === 'control') {
    const load = Object.values(graph).find(n => n.class_type === 'LoadVideo');
    load.inputs.file = uploaded[0].filename;
    const patch = Object.values(graph).find(n => n.class_type === 'MiniMaxH3FunControlNetApply');
    if (settings.controlMode === 'direct') {
      const components = Object.entries(graph).find(([, n]) => n.class_type === 'GetVideoComponents');
      patch.inputs.control_video = [components[0], 0];
      const unused = new Set(['SDPoseKeypointExtractor', 'SDPoseDrawKeypoints', 'RTDETR_detect', 'CheckpointLoaderSimple', 'ResizeImageMaskNode']);
      for (const [id, node] of Object.entries(graph)) if (unused.has(node.class_type) || (node.class_type === 'UNETLoader' && /rt_detr/.test(node.inputs.unet_name))) delete graph[id];
    }
  }
  // Remove sample inputs left behind by the official template.
  const used = new Set(Object.values(graph).flatMap(n => Object.values(n.inputs).filter(Array.isArray).map(v => String(v[0]))));
  for (const [id, n] of Object.entries(graph)) if (n.class_type === 'LoadImage' && !used.has(id)) delete graph[id];
}

function validateGenerationInputs(workflowId, media, settings = {}) {
  if (workflowId !== 'cutout') {
    if (![5, 8, 10].includes(Number(settings.duration ?? 5))) throw new Error('视频时长请选择 5、8 或 10 秒');
    if (!['standard', 'hd', 'ultra'].includes(settings.resolution || 'standard')) throw new Error('分辨率选项无效，请重新选择');
    if (settings.aspectRatio && !['16:9', '1:1', '9:16'].includes(String(settings.aspectRatio).split(' ')[0])) throw new Error('画幅选项无效，请重新选择');
    if (settings.style && !styles.some(style => style.id === settings.style)) throw new Error('特效风格不可用，请重新选择');
    if (settings.seedMode === 'fixed' && (String(settings.seed ?? '').trim() === '' || !Number.isSafeInteger(Number(settings.seed)) || Number(settings.seed) < 0)) throw new Error('固定 Seed 须填写非负安全整数');
  }
  if (workflowId === 'control' && (!Number.isFinite(Number(settings.controlStrength ?? 1)) || Number(settings.controlStrength ?? 1) < 0 || Number(settings.controlStrength ?? 1) > 2 || !['pose', 'direct'].includes(settings.controlMode || 'pose'))) throw new Error('控制强度须在 0 到 2 之间，并选择有效的控制方式');
  if (workflowId === 'r2v' && (!media.length || media.length > 9 || media.some(file => !/\.(png|jpe?g|webp|avif)$/i.test(file)))) throw new Error('参考生视频需要 1 到 9 张图片');
  if (['i2v', 'continuation', 'multiframe', 'control'].includes(workflowId) && !media.length) throw new Error('请先选择参考素材');
  if (['continuation', 'control'].includes(workflowId) && (media.length !== 1 || !/\.(mp4|mov|mkv|webm|avi)$/i.test(media[0]))) throw new Error('请选择一个 MP4、MOV、MKV、WEBM 或 AVI 视频');
  if (['i2v', 'multiframe'].includes(workflowId) && (media.length > (workflowId === 'i2v' ? 2 : 4) || media.some(p => !/\.(png|jpe?g|webp|avif)$/i.test(p)))) throw new Error('图片数量或格式不正确');
  if (workflowId === 'multiframe') {
    const times = media.map((_, i) => Number(settings.frameTimes?.[i] ?? [0, 1.5, 3, 4.5][i]));
    if (times.some((t, i) => !Number.isFinite(t) || t < 0 || t >= Number(settings.duration || 5) || (i > 0 && Math.round(t * 24) <= Math.round(times[i - 1] * 24)))) throw new Error('参考帧时间须递增，且小于视频时长');
  }
}

function resolveGenerationSettings(settings = {}) {
  const fixed = settings.seedMode === 'fixed';
  return { ...settings, fps: 24, seed: fixed ? Number(settings.seed) : randomInt(0, 0x100000000) };
}

module.exports = { styles, applyGenerationSettings, styledPrompt, bindGenerationInputs, validateGenerationInputs, outputSize, resolveGenerationSettings };
