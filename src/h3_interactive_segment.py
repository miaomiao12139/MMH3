"""Local MobileSAM object selection and exact brush corrections for H3 Studio."""
import json
import os

import numpy as np
import torch
from PIL import Image, ImageDraw

import folder_paths
import comfy.model_management as mm


class H3InteractiveSegment:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "prompts": ("STRING", {"multiline": True}), "model_path": ("STRING",)}}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("rgba", "mask")
    FUNCTION = "segment"
    CATEGORY = "H3/Segmentation"

    def segment(self, image, prompts, model_path):
        from mobile_sam import sam_model_registry, SamPredictor

        checkpoint = os.path.join(folder_paths.models_dir, "sams", "mobile_sam.pt")
        # H3 stores shared models outside ComfyUI/models.
        if os.path.isfile(model_path):
            checkpoint = model_path
        if not os.path.isfile(checkpoint):
            raise ValueError("MobileSAM 模型未安装")
        data = json.loads(prompts)
        rgb = (image[0].detach().cpu().numpy()[:, :, :3].clip(0, 1) * 255).astype(np.uint8)
        height, width = rgb.shape[:2]
        device = mm.get_torch_device()
        mm.free_memory(512 * 1024 * 1024, device)
        model = sam_model_registry["vit_t"](checkpoint=checkpoint)
        model.eval().to(device)
        predictor = SamPredictor(model)
        try:
            with torch.inference_mode():
                mm.throw_exception_if_processing_interrupted()
                predictor.set_image(rgb)
                points = data.get("points", [])
                # Brush-only selections provide object prompts. With a clicked or
                # boxed object, strokes only correct pixels without changing it.
                brush_prompts = data.get("strokes", []) if not data.get("box") and not any(p["label"] for p in points) else []
                for stroke in brush_prompts:
                    sampled = stroke["points"][::max(1, len(stroke["points"]) // 8)]
                    points += [dict(p, label=stroke["label"]) for p in sampled[:8]]
                coords = np.array([[p["x"] * (width - 1), p["y"] * (height - 1)] for p in points], dtype=np.float32) if points else None
                labels = np.array([p["label"] for p in points], dtype=np.int32) if points else None
                box = data.get("box")
                bounds = np.array([box["x"] * width, box["y"] * height, (box["x"] + box["width"]) * width, (box["y"] + box["height"]) * height], dtype=np.float32) if box else None
                masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels, box=bounds, multimask_output=True)
                mask = Image.fromarray(masks[int(np.argmax(scores))].astype(np.uint8) * 255)
                # Apply strokes in order, so the most recent brush always wins.
                draw = ImageDraw.Draw(mask)
                for stroke in data.get("strokes", []):
                    radius = max(1, round(stroke["radius"] * min(width, height)))
                    xy = [(round(p["x"] * (width - 1)), round(p["y"] * (height - 1))) for p in stroke["points"]]
                    color = 255 if stroke["label"] else 0
                    if len(xy) > 1:
                        draw.line(xy, fill=color, width=radius * 2, joint="curve")
                    for x, y in xy:
                        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
                mm.throw_exception_if_processing_interrupted()
                alpha = torch.from_numpy(np.array(mask, dtype=np.float32) / 255)
                rgba = torch.cat((image[0].cpu()[:, :, :3], alpha.unsqueeze(-1)), dim=-1).unsqueeze(0)
                return (rgba, alpha.unsqueeze(0))
        finally:
            model.cpu()
            mm.soft_empty_cache()


NODE_CLASS_MAPPINGS = {"H3InteractiveSegment": H3InteractiveSegment}
NODE_DISPLAY_NAME_MAPPINGS = {"H3InteractiveSegment": "H3 点击与画笔抠图"}
