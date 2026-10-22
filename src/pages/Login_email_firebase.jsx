import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, Lock, Loader2, LogIn } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";
import { toast } from "@/components/ui/use-toast";

function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const auth = window.firebase?.auth?.();
      if (!auth) throw new Error("Firebase not initialized");

      // Try Firebase Auth first
      try {
        const cred = await auth.signInWithEmailAndPassword(email, password);
        // Also set roster session
        const username = email.split('@')[0];
        localStorage.setItem('repco_username', username);
        const users = safeGetJSON('retail_roster_users_v1', []);
        const found = users.find(u => u.email?.toLowerCase() === email.toLowerCase() || u.username.toLowerCase() === username.toLowerCase());
        localStorage.setItem('repco_currentRole', found?.role || 'staff');
        toast({ title: "Logged in", description: `Welcome ${found?.displayName || username}` });
        navigate("/");
        return;
      } catch (fbErr) {
        // Fallback to your existing roster local users (username/password)
        const users = safeGetJSON('retail_roster_users_v1', []);
        const found = users.find(u => 
          (u.username.toLowerCase() === email.toLowerCase() || u.email?.toLowerCase() === email.toLowerCase()) && 
          u.password === password
        );
        if (found) {
          localStorage.setItem('repco_username', found.username);
          localStorage.setItem('repco_currentRole', found.role);
          toast({ title: "Logged in (roster)", description: `Welcome ${found.username}` });
          navigate("/");
          return;
        }
        throw fbErr;
      }
    } catch (err) {
      let msg = err.message || "Login failed";
      if (msg.includes("wrong-password") || msg.includes("user-not-found") || msg.includes("invalid-credential")) {
        msg = "Invalid email or password";
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      const auth = window.firebase?.auth?.();
      const provider = new window.firebase.auth.GoogleAuthProvider();
      const result = await auth.signInWithPopup(provider);
      const username = result.user.email.split('@')[0];
      localStorage.setItem('repco_username', username);
      const users = safeGetJSON('retail_roster_users_v1', []);
      const found = users.find(u => u.email?.toLowerCase() === result.user.email.toLowerCase());
      localStorage.setItem('repco_currentRole', found?.role || 'staff');
      navigate("/");
    } catch (err) {
      setError(err.message || "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="Welcome back"
      subtitle="Log in to REPCO ROSTER"
      footer={<>Don't have an account? <Link to="/register" className="text-primary font-medium hover:underline">Sign up</Link></>}
    >
      <Button variant="outline" className="w-full h-12 mb-6" onClick={handleGoogle} disabled={loading}>
        <GoogleIcon className="w-5 h-5 mr-2" /> Continue with Google
      </Button>
      <div className="relative mb-6"><div className="absolute inset-0 flex items-center"><div className="w-full border-t" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-3 text-muted-foreground">or</span></div></div>
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      <form onSubmit={handleLogin} className="space-y-4">
        <div className="space-y-2"><Label>Email or Username</Label><div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" /><Input value={email} onChange={e=>setEmail(e.target.value)} className="pl-10 h-12" placeholder="you@example.com" required /></div></div>
        <div className="space-y-2"><Label>Password</Label><div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" /><Input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="pl-10 h-12" placeholder="••••••••" required /></div></div>
        <Button type="submit" className="w-full h-12" disabled={loading}>{loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Logging in...</> : "Log in"}</Button>
      </form>
    </AuthLayout>
  );
}
