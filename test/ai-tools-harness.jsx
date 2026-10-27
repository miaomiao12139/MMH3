import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AiToolsWorkspace from '../src/renderer/AiToolsWorkspace.jsx';
import '../src/renderer/styles.css';
function App() {
  const [tool, setTool] = useState('segment');
  const [active, setActive] = useState(true);
  return <><button id="sidebar-understand" onClick={() => setTool('understand')}>图像理解侧栏</button><button id="sidebar-segment" onClick={() => setTool('segment')}>智能抠图侧栏</button><button id="sidebar-image-enhance" onClick={() => setTool("image-enhance")}>图片增强侧栏</button><button id="toggle-ai-page" onClick={() => setActive(v => !v)}>切换页面</button><AiToolsWorkspace active={active} tool={tool} onToolChange={setTool} /></>;
}
createRoot(document.getElementById('root')).render(<App/>);
