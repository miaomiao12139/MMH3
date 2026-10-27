"""Prepare local Studio video inputs without loading AI models."""
import sys
import math
from fractions import Fraction

import av


def prepare(source, target, mode, duration):
    if mode not in ('continuation', 'control') or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid video preparation mode or duration')
    with av.open(source) as container:
        if not container.streams.video:
            raise ValueError('Input has no video stream')
        stream = container.streams.video[0]
        if mode == 'continuation':
            # Seek near the end, then decode through the last valid frame.
            if stream.duration:
                container.seek(max(0, stream.duration - int(2 / stream.time_base)), stream=stream)
            last = None
            for frame in container.decode(stream):
                last = frame
            if last is None:
                raise ValueError('Video has no decodable frames')
            last.to_image().convert('RGB').save(target)
            return
        with av.open(target, 'w') as output:
            scale = min(1, 1024 / max(stream.width, stream.height))
            width = max(2, int(stream.width * scale) // 2 * 2)
            height = max(2, int(stream.height * scale) // 2 * 2)
            encoded = output.add_stream('libx264', rate=24)
            encoded.width, encoded.height, encoded.pix_fmt = width, height, 'yuv420p'
            encoded.options = {'crf': '18', 'preset': 'veryfast'}
            index = 0
            origin = None
            last = None
            def write_frame(frame):
                nonlocal index
                converted = frame.reformat(width=width, height=height, format='yuv420p')
                converted.pts, converted.time_base = index, Fraction(1, 24)
                for packet in encoded.encode(converted):
                    output.mux(packet)
                index += 1
            source_rate = float(stream.average_rate or stream.base_rate or 24)
            for decoded_index, frame in enumerate(container.decode(stream)):
                timestamp = float(frame.time) if frame.time is not None else decoded_index / source_rate
                if origin is None:
                    origin = timestamp
                timestamp -= origin
                # Fill times before this sample with the previous frame. Using
                # the arriving frame here moves low-fps actions ahead in time.
                while last is not None and index / 24 < timestamp - 1e-8 and index < round(duration * 24):
                    write_frame(last)
                if timestamp >= duration:
                    break
                last = frame
                if abs(index / 24 - timestamp) < 1e-8 and index < round(duration * 24):
                    write_frame(last)
            if last is None:
                raise ValueError('Video has no decodable frames')
            # Hold the last frame if the control clip is shorter than the output.
            while index < round(duration * 24):
                write_frame(last)
            for packet in encoded.encode():
                output.mux(packet)


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]))
