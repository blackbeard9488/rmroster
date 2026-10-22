import React, { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import Register from "./pages/Register.jsx";
import Login from "./pages/Login.jsx";

// Firebase init
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDummy-Repco-Roster-V216",
  authDomain: "repco-roster.firebaseapp.com",
  databaseURL: "https://repco-roster-default-rtdb.firebaseio.com",
  projectId: "repco-roster",
  storageBucket: "repco-roster.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
const FIREBASE_DB_URL = "https://repco-roster-default-rtdb.firebaseio.com";

function initFirebase() {
  if (typeof window !== 'undefined' && !window.firebase?.apps?.length) {
    try {
      if (window.firebase) {
        window.firebase.initializeApp(FIREBASE_CONFIG);
        console.log('Firebase initialized');
      }
    } catch (e) {
      console.warn('Firebase init', e);
    }
  }
}

function RosterApp() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    initFirebase();
    // Check existing session
    const username = localStorage.getItem('repco_username');
    const role = localStorage.getItem('repco_currentRole');
    if (username) {
      setUser({ username, role: role || 'staff' });
    }
    setLoading(false);
    
    // Load roster data from Firebase
    fetch(`${FIREBASE_DB_URL}/repco_state/retail_roster_byFortnight_v1.json`)
      .then(r=>r.json())
      .then(data=>{
        if(data && Array.isArray(data) && data.length>0){
          const isCorrupted = data.length===1 && (data[0].id==='0' || data[0].id===0 || !data[0].dates);
          if(!isCorrupted){
            localStorage.setItem('retail_roster_byFortnight_v1', JSON.stringify(data));
          }
        }
      }).catch(()=>{});
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F2F2F2]">
        <div className="bg-white border-[3px] border-black rounded-full px-8 py-4 font-black shadow-[6px_6px_0_#111]">LOADING ROSTER...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // If logged in, show the existing roster HTML inside React
  return (
    <div className="min-h-screen bg-[#F2F2F2]">
      {/* Top nav like base44 template */}
      <header className="sticky top-0 z-50 bg-white border-b-[3px] border-black">
        <div className="max-w-[1400px] mx-auto px-4 h-[64px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex gap-[4px]">
              <div className="bg-[#E30613] w-[28px] h-[22px] skew-x-[-12deg]" />
              <div className="bg-[#E30613] w-[10px] h-[22px] skew-x-[-12deg]" />
            </div>
            <span className="font-black italic text-[20px]">REPCO ROSTER</span>
            <span className="ml-3 bg-black text-white text-[10px] font-black px-3 py-1 rounded-full">{user.username} • {user.role}</span>
          </div>
          <button
            onClick={()=>{
              localStorage.removeItem('repco_username');
              localStorage.removeItem('repco_currentRole');
              setUser(null);
              navigate('/login');
            }}
            className="bg-[#111] text-white rounded-full px-5 py-2 text-[11px] font-black border-2 border-black shadow-[3px_3px_0_#111]"
          >
            LOG OUT
          </button>
        </div>
      </header>

      {/* Embed existing roster app */}
      <div className="max-w-[1400px] mx-auto p-4">
        <div className="bg-white border-[3px] border-black rounded-[20px] shadow-[8px_8px_0_#111] overflow-hidden">
          <iframe
            src="/rmroster/index.html"
            className="w-full h-[calc(100vh-100px)] border-0"
            title="Roster"
          />
        </div>
        <p className="text-center text-[10px] font-black text-[#999] mt-4 tracking-widest">
          USERNAME ONLY • FIREBASE SYNC • ROLE-BASED MENUS • CURRENT ROSTER BANNER
        </p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const username = localStorage.getItem('repco_username');
  if (!username) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  useEffect(()=>{
    // Load Firebase scripts
    const scripts = [
      "https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js"
    ];
    scripts.forEach(src=>{
      if(!document.querySelector(`script[src="${src}"]`)){
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        document.head.appendChild(s);
      }
    });
  },[]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><RosterApp /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
