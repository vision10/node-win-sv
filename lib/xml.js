'use strict';

// Minimal XML writer, enough for a WinSW configuration file.
// A node is { tag, attrs?, text?, children? }.

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function render(node, depth, lines) {
  const pad = '\t'.repeat(depth);
  let open = pad + '<' + node.tag;
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (value === undefined || value === null) { continue }
    open += ` ${key}="${escapeAttr(value)}"`;
  }
  const children = node.children || [];
  if (children.length) {
    lines.push(open + '>');
    children.forEach(child => render(child, depth + 1, lines));
    lines.push(`${pad}</${node.tag}>`);
  } else if (node.text !== undefined && node.text !== null && node.text !== '') {
    lines.push(`${open}>${escapeText(node.text)}</${node.tag}>`);
  } else {
    lines.push(open + '/>');
  }
}

function toXml(root) {
  const lines = [];
  render(root, 0, lines);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { toXml, escapeText, escapeAttr };
