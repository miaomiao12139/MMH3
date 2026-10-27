import React, { useEffect, useRef, useState } from "react";
import { createCoverCache } from "./coverCache.mjs";

const covers = createCoverCache();

export default function VideoThumbnail({ item, muted, onLoadedMetadata }) {
  const frameRef = useRef(null);
  const videoRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [cover, setCover] = useState(() => covers.get(item.url) || "");

  useEffect(() => {
    if (!window.IntersectionObserver) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: "160px" });
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!visible) { setCover(""); return; }
    setCover(covers.get(item.url) || "");
    let captured = false;
    const capture = () => {
      if (captured || !video.videoWidth || !video.videoHeight) return;
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.82);
        covers.set(item.url, data);
        setCover(data);
        captured = true;
        video.pause();
      } catch (_) {}
    };
    video.addEventListener("loadeddata", capture);
    video.src = item.url;
    video.load();
    return () => {
      video.removeEventListener("loadeddata", capture);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [visible, item.url]);

  return <div ref={frameRef} className={`video-preview-layer ${cover ? "has-cover" : ""}`}>
    {cover && <img className="video-cover" src={cover} alt="" aria-hidden="true" />}
    <video ref={videoRef} muted={muted} playsInline preload={visible ? "auto" : "none"} onLoadedMetadata={onLoadedMetadata} />
  </div>;
}
