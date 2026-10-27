"""One local synthesis job; exiting releases GPU memory for H3 video jobs."""
import argparse
import contextlib
import json
import math
import os
import re
from pathlib import Path
import sys
import textwrap
import time
import traceback


def send(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    runtime = root / "voice"
    engine = ""
    output = root / "output" / "tts"
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", NLTK_DATA=str(runtime / "nltk_data"))
    payload = json.loads(sys.stdin.readline())
    text = str(payload.get("text", "")).strip()
    speed = float(payload.get("speed", 1.0))
    filename = str(payload.get("filename", ""))
    engine = payload.get("engine", "kokoro")
    voice = payload.get("voice", "ZH" if engine == "melo" else "zf_001")
    if engine not in ("kokoro", "melo"):
        raise ValueError("无效的语音模型")
    models = root / "models" / "tts" / ("Kokoro-82M-v1.1-zh" if engine == "kokoro" else "MeloTTS-Chinese")
    if not isinstance(voice, str) or not (voice == "ZH" if engine == "melo" else re.fullmatch(r"(?:z[fm]_\d{3}|af_maple|af_sol|bf_vale)", voice)):
        raise ValueError("无效的音色")
    if engine == "kokoro" and not (models / "voices" / f"{voice}.pt").is_file():
        raise ValueError("所选音色文件不存在")
    if not text or not any(char.isalnum() for char in text) or len(text) > 3000:
        raise ValueError("请输入 1–3000 字有效文字")
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError("语速应在 0.5–2.0 之间")
    if Path(filename).name != filename or not filename.endswith(".wav") or any(c in filename for c in '/\\:'):
        raise ValueError("无效的音频文件名")
    output.mkdir(parents=True, exist_ok=True)
    target = output / filename
    temporary = target.with_suffix(".partial.wav")
    start = time.perf_counter()
    send("progress", stage="loading", message="正在加载本地语音模型…")
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import soundfile as sf
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        device_name = torch.cuda.get_device_name(0) if device.startswith("cuda") else "CPU"
        torch.set_num_threads(min(os.cpu_count() or 4, 8))
        if engine == "kokoro":
            from kokoro import KModel, KPipeline
            model = KModel(repo_id="hexgrad/Kokoro-82M-v1.1-zh", config=str(models / "config.json"),
                           model=str(models / "kokoro-v1_1-zh.pth")).to(device).eval()
            lang = "z" if voice.startswith("z") else "b" if voice.startswith("b") else "a"
            options = {}
            if lang == "z":
                english = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M-v1.1-zh", model=False)
                options["en_callable"] = lambda value: english.g2p(value)[0]
            pipeline = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M-v1.1-zh", model=model, **options)
        else:
            os.environ["MELO_BERT_PATH"] = str(models / "bert" / "bert-base-multilingual-uncased")
            sys.path.insert(0, str(runtime / "MeloTTS"))
            from melo.api import TTS
            model = TTS(language="ZH", device=device, config_path=str(models / "config.json"),
                        ckpt_path=str(models / "checkpoint.pth"))
    send("progress", stage="synthesizing", message="正在生成语音…", device=device_name)
    with contextlib.redirect_stdout(sys.stderr):
        if engine == "kokoro":
            import numpy as np
            # Keep even unpunctuated Chinese below Kokoro's 510-phoneme limit.
            sentences = re.findall(r"[^。！？!?；;\n]+[。！？!?；;]?|[。！？!?；;]", text)
            pieces = [part for sentence in sentences for part in textwrap.wrap(sentence, width=60 if lang == "z" else 180, break_long_words=True, break_on_hyphens=False)]
            with sf.SoundFile(temporary, mode="w", samplerate=24000, channels=1, subtype="PCM_16") as stream:
                for index, piece in enumerate(pieces):
                    send_line = {"type": "progress", "stage": "synthesizing", "message": f"正在生成语音… {index+1}/{len(pieces)}"}
                    print(json.dumps(send_line, ensure_ascii=False), file=sys.__stdout__, flush=True)
                    for result in pipeline(piece, voice=str(models / "voices" / f"{voice}.pt"), speed=speed):
                        if result.audio is not None:
                            audio = result.audio.detach().cpu().numpy()
                            if not np.isfinite(audio).all():
                                raise RuntimeError("音频包含无效数值")
                            stream.write(audio)
            expected_rate = 24000
        else:
            pieces = textwrap.wrap(text, width=180, break_long_words=True, break_on_hyphens=False)
            model.tts_to_file("。".join(pieces), model.hps.data.spk2id["ZH"], str(temporary), speed=speed, quiet=True)
            expected_rate = 44100
        info = sf.info(temporary)
        if info.frames < 1 or info.samplerate != expected_rate:
            raise RuntimeError("音频输出无效")
        os.replace(temporary, target)
    send("result", filePath=str(target), duration=info.duration, sampleRate=info.samplerate,
         elapsed=time.perf_counter()-start, device=device_name)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        send("error", message=str(error))
        sys.exit(1)
