"""Exercise the installed MobileSAM with two objects and exact brush edits."""
import importlib.util
import json
import os
from pathlib import Path
import sys

import numpy as np
import torch
from PIL import Image, ImageDraw

source_root = Path(__file__).resolve().parents[1]
app_root = source_root.parents[1] / "App"
sys.path.insert(0, str(app_root / "ComfyUI"))
sys.argv = [sys.argv[0], "--disable-auto-launch"]
spec = importlib.util.spec_from_file_location("h3_segment_test", source_root / "src/h3_interactive_segment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

picture = Image.new("RGB", (320, 240), "#f0eee8")
draw = ImageDraw.Draw(picture)
draw.ellipse((28, 55, 132, 185), fill="#d64c39", outline="#93321e", width=3)
draw.rounded_rectangle((200, 60, 287, 180), radius=8, fill="#3979c9", outline="#164a84", width=3)
tensor = torch.from_numpy(np.array(picture, dtype=np.float32) / 255).unsqueeze(0)
node = module.H3InteractiveSegment()
checkpoint = str(app_root / "models/sams/mobile_sam.pt")


def run(name, points=None, box=None, strokes=None):
    rgba, mask = node.segment(tensor, json.dumps({"points": points or [], "box": box, "strokes": strokes or []}), checkpoint)
    assert tuple(rgba.shape) == (1, 240, 320, 4)
    assert tuple(mask.shape) == (1, 240, 320)
    assert torch.equal(rgba[0, :, :, :3], tensor[0])
    assert mask.min() == 0 and mask.max() == 1
    folder = os.environ.get("H3_SEGMENT_TEST_OUTPUT")
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        Image.fromarray((rgba[0].numpy() * 255).astype(np.uint8)).save(Path(folder) / f"{name}.png")
        picture.save(Path(folder) / "input.png")
    return mask[0].numpy()


left = {"x": .25, "y": .5, "label": 1}
right = {"x": .75, "y": .5, "label": 1}
mask = run("select-left", [left, dict(right, label=0)])
assert mask[120, 80] == 1 and mask[120, 240] == 0, "Positive and negative clicks must distinguish objects"
mask = run("select-right", [right, dict(left, label=0)])
assert mask[120, 240] == 1 and mask[120, 80] == 0
mask = run("box-right", box={"x": .59, "y": .2, "width": .34, "height": .6})
assert mask[120, 240] == 1 and mask[120, 80] == 0
mask = run("brush-corrections", [left], strokes=[
    {"label": 0, "radius": .04, "points": [{"x": .25, "y": .5}]},
    {"label": 1, "radius": .04, "points": [{"x": .85, "y": .1}, {"x": .95, "y": .1}]},
])
assert mask[120, 80] == 0 and mask[24, 288] == 1 and mask[120, 240] == 0, "Brushes must change exact pixels without switching the selected object"
mask = run("brush-overwrite", [left], strokes=[
    {"label": 0, "radius": .04, "points": [{"x": .25, "y": .5}]},
    {"label": 1, "radius": .02, "points": [{"x": .25, "y": .5}]},
])
assert mask[120, 80] == 1, "Newest brush must win"
mask = run("brush-only", strokes=[{"label": 1, "radius": .02, "points": [{"x": .25, "y": .5}]}])
assert mask[120, 80] == 1 and mask[120, 240] == 0
print("Real MobileSAM passed: two-object positive/negative selection, SAM box, exact add/erase brushes, overwrite order, brush-only input, RGBA and original dimensions.")
