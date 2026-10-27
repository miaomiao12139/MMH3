export function createCoverCache(maxEntries = 80, maxCharacters = 12 * 1024 * 1024) {
  const entries = new Map();
  let characters = 0;
  return {
    get size() { return entries.size; },
    get characters() { return characters; },
    get(key) {
      const value = entries.get(key);
      if (value !== undefined) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key, value) {
      if (entries.has(key)) { characters -= entries.get(key).length; entries.delete(key); }
      if (value.length > maxCharacters) return;
      entries.set(key, value);
      characters += value.length;
      while (entries.size > maxEntries || characters > maxCharacters) {
        const oldest = entries.keys().next().value;
        characters -= entries.get(oldest).length;
        entries.delete(oldest);
      }
    },
  };
}
