import React from "react";
export function Button({ className="", variant="default", ...props }) {
  const base = "inline-flex items-center justify-center rounded-full border-2 border-black font-black text-[13px] tracking-wide transition-all active:translate-x-[2px] active:translate-y-[2px] active:shadow-none";
  const variants = {
    default: "bg-[#111] text-white shadow-[4px_4px_0_#111] hover:shadow-[2px_2px_0_#111] h-12 px-6",
    outline: "bg-white text-black shadow-[4px_4px_0_#111] hover:shadow-[2px_2px_0_#111] h-12 px-6"
  };
  return <button className={`${base} ${variants[variant]||variants.default} ${className}`} {...props} />;
}
