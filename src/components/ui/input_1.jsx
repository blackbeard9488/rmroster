import React from "react";
export function Input({ className="", ...props }) {
  return <input className={`w-full rounded-full border-[3px] border-black bg-[#F2F2F2] px-5 font-bold text-[14px] focus:outline-none focus:bg-white focus:shadow-[3px_3px_0_#111] transition-all h-12 ${className}`} {...props} />;
}
export function Label({ className="", ...props }) {
  return <label className={`text-[11px] font-black tracking-widest uppercase ${className}`} {...props} />;
}
