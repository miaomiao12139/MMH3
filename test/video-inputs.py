import importlib.util
import pathlib
import tempfile

import av
import numpy as np
from PIL import Image

script = pathlib.Path(__file__).resolve().parents[1] / 'src/video-input.py'
spec = importlib.util.spec_from_file_location('video_input', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='h3-video-test-') as temporary:
    root = pathlib.Path(temporary)
    source = root / 'source.mp4'
    with av.open(str(source), 'w') as output:
        stream = output.add_stream('libx264', rate=30)
        stream.width, stream.height, stream.pix_fmt = 64, 64, 'yuv420p'
        for i in range(30):
            image = np.zeros((64, 64, 3), dtype=np.uint8)
            image[:, :, 0] = round(i * 255 / 29)
            frame = av.VideoFrame.from_ndarray(image, format='rgb24')
            frame.pts = i
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    tail = root / 'tail.png'
    module.prepare(str(source), str(tail), 'continuation', 5)
    assert np.asarray(Image.open(tail))[:, :, 0].mean() > 245, 'Continuation uses the final frame'
    converted = root / 'control.mp4'
    module.prepare(str(source), str(converted), 'control', 2)
    with av.open(str(converted)) as output:
        assert output.streams.video[0].average_rate == 24
        frames = list(output.decode(video=0))
        assert len(frames) == 48, len(frames)
        assert frames[-1].to_ndarray(format='rgb24')[:, :, 0].mean() > 240
    print('Video preparation passed: final frame, 30-to-24 fps, duration and short-clip padding.')
    low = root / 'low-fps.mp4'
    with av.open(str(low), 'w') as output:
        stream = output.add_stream('libx264', rate=2)
        stream.width, stream.height, stream.pix_fmt = 64, 64, 'yuv420p'
        for i, color in enumerate([(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)]):
            image = np.empty((64, 64, 3), dtype=np.uint8)
            image[:] = color
            frame = av.VideoFrame.from_ndarray(image, format='rgb24')
            frame.pts = i
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    aligned = root / 'aligned.mp4'
    module.prepare(str(low), str(aligned), 'control', 2)
    with av.open(str(aligned)) as output:
        frames = list(output.decode(video=0))
        assert len(frames) == 48
        for index in range(12):
            rgb = frames[index].to_ndarray(format='rgb24').mean(axis=(0, 1))
            assert rgb[0] > 240 and rgb[1] < 10, (index, rgb)
        rgb = frames[12].to_ndarray(format='rgb24').mean(axis=(0, 1))
        assert rgb[1] > 240 and rgb[0] < 10, rgb
    print('Temporal alignment passed: a 2-fps action changes at 0.5s, not one 24-fps frame after start.')
