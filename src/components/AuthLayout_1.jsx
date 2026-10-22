import React from "react";

export default function AuthLayout({ icon: Icon, title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F2F2F2] p-4 relative overflow-hidden">
      {/* Repco corners like your original */}
      <div className="fixed top-0 left-0 w-[28vw] max-w-[360px] h-[48vh] max-h-[600px] bg-[#E30613] pointer-events-none" style={{clipPath:"polygon(0 0,100% 0,0 100%)"}} />
      <div className="fixed bottom-0 right-0 w-[28vw] max-w-[360px] h-[48vh] max-h-[600px] bg-[#0a0a0a] pointer-events-none" style={{clipPath:"polygon(100% 0,100% 100%,0 100%)"}} />
      
      <div className="w-full max-w-[440px] relative z-10">
        <div className="bg-white border-[3px] border-black rounded-[24px] shadow-[8px_8px_0_#111] p-8">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div className="flex items-center skew-x-[-6deg]">
              <div className="flex gap-[6px] mr-3">
                <div className="bg-[#E30613] w-[40px] h-[32px] skew-x-[-18deg] rounded-[2px]" />
                <div className="bg-[#E30613] w-[14px] h-[32px] skew-x-[-18deg] rounded-[2px]" />
                <div className="bg-[#E30613] w-[14px] h-[32px] skew-x-[-18deg] rounded-[2px]" />
              </div>
              <div className="font-black italic text-[32px] tracking-tighter">REPCO</div>
            </div>
          </div>

          {Icon && (
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 rounded-full bg-[#111] flex items-center justify-center">
                <Icon className="w-6 h-6 text-white" />
              </div>
            </div>
          )}
          
          <h1 className="text-[22px] font-black text-center tracking-tight mb-1">{title}</h1>
          {subtitle && <p className="text-[13px] text-[#666] text-center font-bold mb-6">{subtitle}</p>}
          
          <div>{children}</div>
          
          {footer && (
            <div className="mt-6 text-center text-[13px] font-bold text-[#555]">
              {footer}
            </div>
          )}
        </div>
        
        <p className="text-center text-[11px] font-black mt-4 tracking-wide text-[#999]">
          ROSTER • USERNAME ONLY • FIREBASE
        </p>
      </div>
    </div>
  );
}
