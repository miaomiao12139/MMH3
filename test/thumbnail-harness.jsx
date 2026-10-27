import React from "react";
import { createRoot } from "react-dom/client";
import VideoThumbnail from "../src/renderer/VideoThumbnail.jsx";

createRoot(document.getElementById("root")).render(<>
  <section id="near"><VideoThumbnail item={{ url: "/test/fixtures/upgrade-native-test.mp4?near" }} muted /></section>
  <div style={{ height: 2000 }} />
  <section id="far"><VideoThumbnail item={{ url: "/test/fixtures/upgrade-native-test.mp4?far" }} muted /></section>
  <div style={{ height: 1000 }} />
</>);
