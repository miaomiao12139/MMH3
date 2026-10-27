import React from "react";
import { Image, Images, WandSparkles, Scissors, Film, Layers, SlidersHorizontal, Sparkles, AudioLines, ListVideo, Brain, ScanLine, Volume2, VolumeX } from "lucide-react";
const icons = { i2v: Image, r2v: Images, t2v: WandSparkles, cutout: Scissors, continuation: Film, multiframe: Layers, control: SlidersHorizontal, enhance: Sparkles, "image-enhance": Sparkles, interpolate: Film, segment: ScanLine, understand: Brain, voice: AudioLines, queue: ListVideo, sound: Volume2, muted: VolumeX };
export default function NavigationIcon({ name }) { const Icon = icons[name] || Image; return <Icon size={18} strokeWidth={1.7} aria-hidden="true" />; }
