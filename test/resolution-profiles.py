import json
import pathlib
import sys

project = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project.parents[1] / 'App/ComfyUI'))
sys.argv = [sys.argv[0]]
from comfy_extras.nodes_resolution import ResolutionSelector

profiles = json.loads((project / 'src/generation-profiles.json').read_text(encoding='utf-8'))
ratios = {'landscape': '16:9 (Widescreen)', 'portrait': '9:16 (Portrait Widescreen)', 'square': '1:1 (Square)'}
for aspect, levels in profiles.items():
    for level, expected in levels.items():
        result = ResolutionSelector.execute(ratios[aspect], expected[0] * expected[1] / (1024 * 1024), 32)
        actual = [result[0], result[1]]
        assert actual == expected, (aspect, level, actual, expected)
print('All 9 displayed resolutions match actual ComfyUI ResolutionSelector output.')
