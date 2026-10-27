export const REFERENCE_TYPES = ["image"];

export const TYPE_LABELS = { image: "图" };

export const ROLE_LABELS = {
  character: "人物",
  environment: "背景",
  clothing: "服装",
  style: "风格",
  motion: "动作",
  general: "普通参考",
};

const ROLE_RULES = [
  ["environment", /背景|场景|环境|地点|空间|布景/],
  ["character", /人物|角色|主角|脸|身份|外貌|形象|人物形象/],
  ["clothing", /衣服|服装|穿搭|造型/],
  ["style", /风格|画风|色调|光影|质感|氛围/],
  ["motion", /动作|舞蹈|姿势|运动|走路|表演/],
];

const MODEL_TOKENS = { image: (index) => `<Picture ${index}>` };

function cleanAsset(asset) {
  if (!asset || typeof asset !== "object" || !(asset.assetId || asset.id)) return null;
  if (asset.type && asset.type !== "image") return null;
  const type = "image";
  const assetId = String(asset.assetId || asset.id);
  return { ...asset, type, id: assetId, assetId };
}

export function assetDisplayName(asset, assets = []) {
  const normalized = cleanAsset(asset);
  if (!normalized) return "素材";
  const sameType = assets.map(cleanAsset).filter((item) => item && item.type === normalized.type);
  const index = sameType.findIndex((item) => item.id === normalized.id) + 1;
  return `${TYPE_LABELS[normalized.type]}${index > 0 ? index : normalized.index || ""}`;
}

export function modelTokenForAsset(asset, assets = []) {
  const normalized = cleanAsset(asset);
  if (!normalized) return "<Reference>";
  const sameType = assets.map(cleanAsset).filter((item) => item && item.type === normalized.type);
  const index = sameType.findIndex((item) => item.id === normalized.id) + 1;
  return (MODEL_TOKENS[normalized.type] || MODEL_TOKENS.image)(Math.max(1, index || Number(normalized.index) || 1));
}

export function promptPartsToText(parts, assets = []) {
  return (Array.isArray(parts) ? parts : []).map((part) => {
    if (!part || part.type === "text") return String(part?.text || "");
    if (part.type !== "mention") return "";
    const asset = assets.find((item) => String(item.assetId || item.id) === String(part.assetId));
    return `@${asset ? assetDisplayName(asset, assets) : (part.label || "素材")}`;
  }).join("");
}

function roleForContext(context, anchor = Math.floor(String(context || "").length / 2)) {
  let selected = "general";
  let closestDistance = Infinity;
  for (const [role, rule] of ROLE_RULES) {
    const match = String(context || "").match(rule);
    if (!match || match.index === undefined) continue;
    const distance = Math.abs((match.index + (match[0]?.length || 0) / 2) - anchor);
    if (distance < closestDistance) {
      selected = role;
      closestDistance = distance;
    }
  }
  return selected;
}

function mentionLabelForAsset(asset, assets) {
  return `@${assetDisplayName(asset, assets)}`;
}

function legacyPartsFromText(text, assets) {
  const parts = [];
  let cursor = 0;
  const pattern = /@图(\d+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push({ type: "text", text: text.slice(cursor, match.index) });
    const type = "image";
    const index = Number(match[1]) - 1;
    const candidates = assets.filter((asset) => asset.type === type);
    const asset = candidates[index];
    parts.push({ type: "mention", assetId: asset?.id || `missing:image:${index + 1}`, label: `图${index + 1}` });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || !parts.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

function normalizeParts(userPrompt, assets) {
  if (userPrompt && typeof userPrompt === "object" && Array.isArray(userPrompt.parts)) {
    const normalized = [];
    const append = (part) => {
      if (!part) return;
      const previous = normalized[normalized.length - 1];
      if (part.type === "text" && previous?.type === "text") previous.text += part.text;
      else normalized.push(part);
    };
    userPrompt.parts.forEach((part) => {
      if (part?.type === "mention") {
        append({ type: "mention", assetId: String(part.assetId || ""), label: String(part.label || "素材"), role: String(part.role || "") });
      } else {
        legacyPartsFromText(String(part?.text || ""), assets).forEach(append);
      }
    });
    return normalized.length ? normalized : [{ type: "text", text: "" }];
  }
  return legacyPartsFromText(String(userPrompt || ""), assets);
}

function buildIndexedAssets(assets) {
  return assets.map(cleanAsset).filter(Boolean).map((asset) => ({
    asset,
    index: assets.filter((candidate) => candidate.type === asset.type).findIndex((candidate) => candidate.id === asset.id) + 1,
  }));
}

function roleSentence(reference) {
  const roleText = {
    environment: "the environment, background and scene",
    character: "the main character identity and appearance",
    clothing: "the clothing and styling",
    style: "the visual style, lighting and color tone",
    motion: "the movement and action reference",
    general: "visual reference information",
  }[reference.role] || "visual reference information";
  return `${reference.modelToken} provides ${roleText}.`;
}

export function parseReferencePrompt(userPrompt, referenceAssets = [], options = {}) {
  const unsupportedAssets = referenceAssets.filter((asset) => asset && typeof asset === "object" && asset.type && asset.type !== "image").map((asset) => ({
    assetId: String(asset.assetId || asset.id || ""),
    type: String(asset.type),
  }));
  const assets = referenceAssets.map(cleanAsset).filter(Boolean);
  const parts = normalizeParts(userPrompt, assets);
  const indexed = buildIndexedAssets(assets);
  const occurrences = [];
  let originalPrompt = "";

  for (const part of parts) {
    if (part.type === "text") {
      originalPrompt += part.text;
      continue;
    }
    const asset = assets.find((item) => item.id === part.assetId || item.assetId === part.assetId);
    const mention = asset ? mentionLabelForAsset(asset, assets) : `@${part.label || "素材"}`;
    const start = originalPrompt.length;
    originalPrompt += mention;
    const indexedAsset = asset && indexed.find((item) => item.asset.id === asset.id);
    occurrences.push({ start, end: originalPrompt.length, asset, mention, part, modelToken: asset ? MODEL_TOKENS.image(indexedAsset?.index || 1) : "" });
  }

  const references = [];
  const invalidMentions = [];
  for (const occurrence of occurrences) {
    if (!occurrence.asset) {
      if (!invalidMentions.some((item) => item.assetId === occurrence.part?.assetId && item.mention === occurrence.mention)) {
        invalidMentions.push({ assetId: occurrence.part?.assetId || "", mention: occurrence.mention });
      }
      continue;
    }
    if (references.some((item) => item.assetId === occurrence.asset.id)) continue;
    const indexedAsset = indexed.find((item) => item.asset.id === occurrence.asset.id);
    const contextStart = Math.max(0, occurrence.start - 48);
    const context = originalPrompt.slice(contextStart, Math.min(originalPrompt.length, occurrence.end + 96));
    const afterContext = originalPrompt.slice(occurrence.end, Math.min(originalPrompt.length, occurrence.end + 72));
    const beforeContext = originalPrompt.slice(Math.max(0, occurrence.start - 48), occurrence.start);
    const inferredRole = roleForContext(afterContext, 0) !== "general"
      ? roleForContext(afterContext, 0)
      : roleForContext(beforeContext, beforeContext.length);
    references.push({
      assetId: occurrence.asset.id,
      mention: occurrence.mention,
      type: "image",
      index: indexedAsset?.index || 1,
      modelToken: MODEL_TOKENS.image(indexedAsset?.index || 1),
      role: options.roleOverrides?.[occurrence.asset.id] || occurrence.part?.role || inferredRole || roleForContext(context, occurrence.start - contextStart + (occurrence.end - occurrence.start) / 2),
    });
  }

  const cleanedPrompt = occurrences.slice().reverse().reduce((value, occurrence) => {
    if (!occurrence.asset) return value;
    return `${value.slice(0, occurrence.start)}${occurrence.modelToken}${value.slice(occurrence.end)}`;
  }, originalPrompt);

  const allInputs = indexed.map(({ asset, index }) => ({
    assetId: asset.id,
    type: asset.type,
    index,
    modelToken: MODEL_TOKENS[asset.type](index),
    filePath: asset.filePath || asset.path || "",
    displayName: assetDisplayName(asset, assets),
    mentioned: references.some((reference) => reference.assetId === asset.id),
  }));
  const workflowInputs = { images: allInputs };

  const roleLines = references.map(roleSentence);
  const hasCharacter = references.some((item) => item.role === "character");
  const hasEnvironment = references.some((item) => item.role === "environment");
  const constraints = references.length ? [
    hasCharacter ? "Preserve the referenced character identity, facial features, hairstyle and clothing." : "",
    hasEnvironment ? "Preserve the referenced environment, composition, lighting and atmosphere." : "",
    hasCharacter && hasEnvironment ? "Integrate the character naturally with coherent scale, perspective, lighting and shadows." : "",
    "Natural motion, smooth temporal consistency and stable appearance.",
  ].filter(Boolean) : [];
  const expandedPrompt = [...roleLines, cleanedPrompt.trim(), ...constraints].filter(Boolean).join("\n\n");
  return {
    originalPrompt,
    cleanedPrompt,
    references,
    expandedPrompt: expandedPrompt || cleanedPrompt,
    workflowInputs,
    invalidMentions,
    unsupportedAssets,
    parts,
  };
}
