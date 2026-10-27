import React, { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_LABELS, assetDisplayName, parseReferencePrompt, promptPartsToText } from "./referencePromptParser.mjs";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function partsToHtml(parts, assets) {
  return (Array.isArray(parts) ? parts : []).map((part) => {
    if (!part || part.type === "text") return escapeHtml(part?.text || "").replaceAll("\n", "<br>");
    const asset = assets.find((item) => String(item.id) === String(part.assetId));
    const label = asset ? assetDisplayName(asset, assets) : `${part.label || "素材"} 已删除`;
    const invalid = asset ? "" : " invalid";
    const thumbnail = asset?.thumbnailUrl || asset?.fileUrl;
    const thumbnailMarkup = thumbnail
      ? `<img src="${escapeHtml(thumbnail)}" alt="" aria-hidden="true">`
      : "";
    return `<span class="mention-token${invalid}" contenteditable="false" data-asset-id="${escapeHtml(part.assetId)}" data-asset-label="${escapeHtml(part.label || "素材")}" data-role="${escapeHtml(part.role || "")}">${thumbnailMarkup}<span class="mention-token-label">@${escapeHtml(label)}</span></span>`;
  }).join("");
}

function readParts(root) {
  const parts = [];
  const appendText = (text) => {
    if (!text) return;
    const previous = parts[parts.length - 1];
    if (previous?.type === "text") previous.text += text;
    else parts.push({ type: "text", text });
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset?.assetId) {
      parts.push({ type: "mention", assetId: node.dataset.assetId, label: node.dataset.assetLabel || "素材", role: node.dataset.role || "" });
      return;
    }
    if (node.tagName === "BR") {
      appendText("\n");
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return parts.length ? parts : [{ type: "text", text: "" }];
}

function selectionBeforeCaret(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return "";
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString();
}

export default function ReferencePromptEditor({ parts, assets, onChange, disabled = false, placeholder }) {
  const editorRef = useRef(null);
  const selectionRef = useRef(null);
  const composingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const html = useMemo(() => partsToHtml(parts, assets), [parts, assets]);
  const parsed = useMemo(() => parseReferencePrompt({ parts }, assets), [parts, assets]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const focused = document.activeElement === editor;
    // Do not rewrite a focused contenteditable after every keystroke. Parent
    // updates can otherwise move the caret and interrupt IME composition.
    if (!composingRef.current && !focused) editor.innerHTML = html;
  }, [html]);

  const emitParts = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (composingRef.current) return;
    onChange(readParts(editor));
    const before = selectionBeforeCaret(editor) || editor.textContent || "";
    const match = before.match(/@([^\s@]*)$/);
    if (match) {
      selectionRef.current = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null;
      setMentionQuery(match[1]);
      setMenuOpen(assets.length > 0);
    } else {
      setMenuOpen(false);
      setMentionQuery("");
    }
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
    setMenuOpen(false);
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
    // Let the browser commit the final IME text before reading the editor.
    window.setTimeout(() => emitParts(), 0);
  };

  const captureSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) selectionRef.current = selection.getRangeAt(0).cloneRange();
  };

  const handlePaste = (event) => {
    if (disabled) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text) return;
    document.execCommand("insertText", false, text);
    emitParts();
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      setMenuOpen(false);
      return;
    }
    if (event.isComposing || composingRef.current) return;
    if (event.key === "@") {
      selectionRef.current = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null;
      window.setTimeout(() => {
        if (!disabled && assets.length) {
          setMentionQuery("");
          setMenuOpen(true);
        }
      }, 0);
    }
  };

  const insertMention = (asset) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const range = selectionRef.current?.cloneRange() || (() => {
      const fallback = document.createRange();
      fallback.selectNodeContents(editor);
      fallback.collapse(false);
      return fallback;
    })();
    if (range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0 && range.startContainer.nodeValue[range.startOffset - 1] === "@") {
      range.setStart(range.startContainer, range.startOffset - 1);
    }
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    const token = document.createElement("span");
    token.className = "mention-token";
    token.contentEditable = "false";
    token.dataset.assetId = asset.id;
    token.dataset.assetLabel = assetDisplayName(asset, assets);
    token.dataset.role = "";
    const thumbnail = asset.thumbnailUrl || asset.fileUrl;
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = "";
      image.setAttribute("aria-hidden", "true");
      token.appendChild(image);
    }
    const label = document.createElement("span");
    label.className = "mention-token-label";
    label.textContent = `@${assetDisplayName(asset, assets)}`;
    token.appendChild(label);
    const spacer = document.createTextNode(" ");
    fragment.append(token, spacer);
    range.insertNode(fragment);
    range.setStartAfter(spacer);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
    onChange(readParts(editor));
    setMenuOpen(false);
    setMentionQuery("");
  };

  const filteredAssets = assets.filter((asset) => !mentionQuery || assetDisplayName(asset, assets).includes(mentionQuery));

  return <div className="reference-prompt-editor-wrap">
    <div
      ref={editorRef}
      className="reference-prompt-editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={emitParts}
      onKeyUp={captureSelection}
      onClick={captureSelection}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
      role="textbox"
      aria-multiline="true"
      aria-label="Prompt"
    />
    {menuOpen && filteredAssets.length > 0 && <div className="mention-menu" onMouseDown={(event) => event.preventDefault()}>
      <div className="mention-menu-title">插入参考图</div>
      {filteredAssets.map((asset) => <button key={asset.id} type="button" onClick={() => insertMention(asset)}>
        {(asset.thumbnailUrl || asset.fileUrl) ? <img src={asset.thumbnailUrl || asset.fileUrl} alt="" /> : <span className="mention-menu-icon">图</span>}
        <span>{assetDisplayName(asset, assets)}</span>
      </button>)}
    </div>}
    {(parsed.references.length > 0 || parsed.invalidMentions.length > 0) && <div className="reference-relations">
      <div className="reference-relations-head"><span>引用关系</span><small>按当前图片顺序提交</small></div>
      {parsed.invalidMentions.map((item) => <div className="reference-relation invalid" key={`invalid-${item.assetId}`}><span>{item.mention}</span><b>图片已删除，请移除引用</b></div>)}
      {parsed.references.map((reference) => <div className="reference-relation" key={reference.assetId}><span>{reference.mention}</span><select value={reference.role} onChange={(event) => onChange(parts.map((part) => part.type === "mention" && part.assetId === reference.assetId ? { ...part, role: event.target.value } : part))}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>)}
    </div>}
    <span className="reference-prompt-count">{promptPartsToText(parts, assets).length} / 2000</span>
  </div>;
}
