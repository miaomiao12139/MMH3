const path = require('node:path');

function savedVideoPaths(record, graph, outputDir, exists) {
  const files = new Set();
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type !== 'SaveVideo') continue;
    const saved = record.outputs?.[id] || {};
    for (const item of [...(saved.images || []), ...(saved.gifs || []), ...(saved.videos || [])]) {
      if (item.type !== 'output' || typeof item.filename !== 'string' || !/\.(mp4|webm|mov|mkv|avi)$/i.test(item.filename)) continue;
      const target = path.resolve(outputDir, item.subfolder || '', item.filename);
      const relative = path.relative(outputDir, target);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      if (exists(target)) files.add(target);
    }
  }
  return [...files];
}

module.exports = { savedVideoPaths };
