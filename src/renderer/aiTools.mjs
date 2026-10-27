export const aiTools = [
  { id: "enhance", title: "视频画质增强", description: "将视频放大 4 倍并修复细节，保留原视频帧率", accept: "video/*", icon: "✦", model: "Real-ESRGAN x4plus", group: "视频工具" },
  { id: "interpolate", title: "视频补帧", description: "增加视频帧数，让运动更流畅", accept: "video/*", icon: "⏵", model: "FILM", group: "视频工具" },
  { id: "image-enhance", title: "图片画质增强", description: "将图片放大 4 倍并修复细节，导出 PNG", accept: "image/*", icon: "✦", model: "Real-ESRGAN x4plus", group: "图片工具" },
  { id: "segment", title: "智能抠图与分割", description: "点击选择对象、画笔修边，导出透明 PNG", accept: "image/*", icon: "◌", model: "MobileSAM + 画笔", group: "图片工具" },
  { id: "understand", title: "图像理解", description: "在本机理解图片内容，回答问题或生成描述", accept: "image/*", icon: "◉", model: "Qwen3-VL 4B", group: "图片工具" },
];
