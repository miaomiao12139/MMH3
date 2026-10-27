const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = label => { throw new Error(`配置中的${label}格式无效，未应用任何更改`); };
const stringFields = (value, fields, label) => {
  if (!object(value) || fields.some(key => value[key] !== undefined && typeof value[key] !== 'string')) fail(label);
};
const settings = value => {
  if (!object(value)) fail('生成参数');
  for (const [key, allowed] of Object.entries({ resolution: ['standard', 'hd', 'ultra'], duration: [5, 8, 10], seedMode: ['fixed', 'random'], samplingMode: ['quality', 'turbo4', 'turbo8'], controlMode: ['pose', 'direct'] })) {
    if (value[key] !== undefined && !allowed.includes(value[key])) fail('生成参数');
  }
  if (value.aspectRatio !== undefined && (typeof value.aspectRatio !== 'string' || !['16:9', '1:1', '9:16'].includes(value.aspectRatio.split(' ')[0]))) fail('画幅');
  if (value.frameTimes !== undefined && (!Array.isArray(value.frameTimes) || value.frameTimes.length > 4 || value.frameTimes.some(time => typeof time !== 'number' || !Number.isFinite(time)))) fail('参考帧时间');
  if (value.controlStrength !== undefined && (typeof value.controlStrength !== 'number' || value.controlStrength < 0 || value.controlStrength > 2 || !Number.isFinite(value.controlStrength))) fail('控制强度');
  return { ...value, fps: 24, batchCount: 1 };
};
function parts(value) {
  if (!Array.isArray(value) || value.some(part => !object(part) || !['text', 'mention'].includes(part.type) || (part.type === 'text' ? typeof part.text !== 'string' : typeof part.assetId !== 'string'))) fail('提示词引用');
}
function assets(value, label, reference = false) {
  if (!Array.isArray(value)) fail(label);
  for (const asset of value) {
    stringFields(asset, ['id', 'assetId', 'path', 'filePath', 'sourcePath', 'fileUrl', 'thumbnailUrl', 'name'], label);
    if (typeof (asset.id || asset.assetId) !== 'string' || typeof (reference ? asset.filePath : asset.path) !== 'string') fail(label);
  }
}

export function normalizeStudioConfig(payload) {
  if (!object(payload) || ![1, 2].includes(payload.version)) fail('版本');
  const next = structuredClone(payload);
  if (next.profile !== undefined) stringFields(next.profile, ['name', 'avatar'], '用户资料');
  if (next.theme !== undefined && !['light', 'dark'].includes(next.theme)) fail('主题');
  for (const key of ['audioMuted', 'notificationsEnabled']) if (next[key] !== undefined && typeof next[key] !== 'boolean') fail('通知或声音开关');
  if (next.promptPresets !== undefined) {
    if (!Array.isArray(next.promptPresets) || next.promptPresets.some(item => !object(item) || typeof item.id !== 'string' || typeof item.text !== 'string')) fail('常用预设');
    next.promptPresets = next.promptPresets.slice(0, 50);
  }
  if (next.promptHistory !== undefined) {
    if (!object(next.promptHistory)) fail('提示词历史');
    for (const entries of Object.values(next.promptHistory)) {
      if (!Array.isArray(entries)) fail('提示词历史');
      for (const entry of entries) {
        stringFields(entry, ['id', 'text'], '提示词历史');
        if (typeof entry.id !== 'string' || typeof entry.text !== 'string') fail('提示词历史');
        if (entry.parts !== undefined) parts(entry.parts);
      }
    }
  }
  if (next.assetLibrary !== undefined) { assets(next.assetLibrary, '素材库'); next.assetLibrary = next.assetLibrary.slice(0, 120); }
  if (next.videoFavorites !== undefined && (!Array.isArray(next.videoFavorites) || next.videoFavorites.some(file => typeof file !== 'string'))) fail('收藏');
  if (next.settings !== undefined) next.settings = settings(next.settings);
  if (next.workflowDrafts !== undefined) {
    if (!object(next.workflowDrafts)) fail('模式草稿');
    for (const draft of Object.values(next.workflowDrafts)) {
      stringFields(draft, ['prompt'], '模式草稿');
      for (const key of ['files', 'previews']) if (draft[key] !== undefined && (!Array.isArray(draft[key]) || draft[key].some(file => typeof file !== 'string'))) fail('草稿素材');
      if (draft.promptParts !== undefined) parts(draft.promptParts);
      if (draft.referenceAssets !== undefined) assets(draft.referenceAssets, '参考素材', true);
      if (draft.settings !== undefined) draft.settings = settings(draft.settings);
    }
  }
  if (next.cutoutOptions !== undefined) {
    stringFields(next.cutoutOptions, ['format', 'filenamePrefix', 'batchName'], '抠图参数');
    if (next.cutoutOptions.format !== undefined && !['png', 'webp'].includes(next.cutoutOptions.format)) fail('抠图格式');
    for (const key of ['preserveName', 'batchFolder']) if (next.cutoutOptions[key] !== undefined && typeof next.cutoutOptions[key] !== 'boolean') fail('抠图参数');
  }
  return next;
}
