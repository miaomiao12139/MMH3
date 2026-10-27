function validateSegmentPrompts(value = {}) {
  const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
  const coordinate = p => p && unit(p.x) && unit(p.y);
  const points = value.points ?? [];
  const strokes = value.strokes ?? [];
  const box = value.box ?? null;
  if (!Array.isArray(points) || points.length > 128 || points.some(p => !coordinate(p) || ![0, 1].includes(p.label))) throw new Error("点击选区无效，请重新选择（最多 128 个点）");
  if (box && (!coordinate(box) || !unit(box.width) || !unit(box.height) || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001)) throw new Error("框选区域无效，请重新框选");
  if (!Array.isArray(strokes) || strokes.length > 100 || strokes.some(s => !s || ![0, 1].includes(s.label) || !Number.isFinite(s.radius) || s.radius < .001 || s.radius > .15 || !Array.isArray(s.points) || !s.points.length || s.points.some(p => !coordinate(p))) || strokes.reduce((n, s) => n + s.points.length, 0) > 10000) throw new Error("画笔区域无效或笔画过多，请清空后重试");
  if (!box && !points.some(p => p.label === 1) && !strokes.some(s => s.label === 1)) throw new Error("请先点击要保留的对象、框选对象或用保留画笔涂选");
  return { points: points.map(({ x, y, label }) => ({ x, y, label })), box, strokes };
}

module.exports = { validateSegmentPrompts };
