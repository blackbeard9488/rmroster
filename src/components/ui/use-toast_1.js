import React from "react";
export function toast({ title, description }) {
  console.log(title, description);
  // Simple toast - replace with your UI lib
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 20px;border-radius:9999px;font-weight:900;font-size:12px;z-index:999999;border:3px solid #111;box-shadow:6px 6px 0 #111;';
  el.textContent = title + (description ? ': ' + description : '');
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}
