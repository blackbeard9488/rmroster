import React from "react";
export function InputOTP({ children, value, onChange, maxLength=6 }) {
  return (
    <div className="flex gap-2 justify-center">
      {Array.from({length:maxLength}).map((_,i)=>(
        <input
          key={i}
          value={value[i]||""}
          onChange={(e)=>{
            const newVal = value.split('');
            newVal[i] = e.target.value.slice(-1);
            onChange(newVal.join('').slice(0,maxLength));
            if(e.target.value && i<maxLength-1){
              const next = document.getElementById(`otp-${i+1}`);
              if(next) next.focus();
            }
          }}
          id={`otp-${i}`}
          className="w-12 h-12 rounded-[12px] border-[3px] border-black text-center font-black text-[18px] focus:outline-none focus:shadow-[3px_3px_0_#111]"
          maxLength={1}
        />
      ))}
    </div>
  );
}
export function InputOTPGroup({ children }) { return <>{children}</>; }
export function InputOTPSlot() { return null; }
