import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Lock, Loader2, LogIn } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { toast } from "@/components/ui/use-toast";

function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const cleanUsername = username.trim();
      if (!cleanUsername) throw new Error("Enter username");
      
      const users = safeGetJSON('retail_roster_users_v1', []);
      const found = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
      
      if (!found) {
        throw new Error("Username not found");
      }
      if (found.password !== password) {
        throw new Error("Incorrect password");
      }

      // Set session - your existing roster system uses these keys
      localStorage.setItem('repco_username', found.username);
      localStorage.setItem('repco_currentRole', found.role || 'staff');
      localStorage.setItem('repco_session', JSON.stringify({
        username: found.username,
        role: found.role,
        loginAt: Date.now()
      }));

      // Push login event to Firebase
      try {
        const db = window.firebase?.database?.();
        if (db) {
          await db.ref(`logins/${found.username.toLowerCase()}/${Date.now()}`).set({
            username: found.username,
            role: found.role,
            at: Date.now()
          });
        }
        fetch(`https://repco-roster-default-rtdb.firebaseio.com/logins/${found.username.toLowerCase()}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: found.username, at: Date.now() })
        }).catch(()=>{});
      } catch {}

      toast({ title: "Logged in", description: `Welcome ${found.firstName || found.username}` });
      navigate("/");
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="REPCO ROSTER"
      subtitle="Username login only"
      footer={<>No account? <Link to="/register" className="text-primary font-medium hover:underline">Create one</Link></>}
    >
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      <form onSubmit={handleLogin} className="space-y-4">
        <div className="space-y-2">
          <Label>Username</Label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={username} onChange={e=>setUsername(e.target.value)} className="pl-10 h-12" placeholder="johndoe" required autoFocus />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="pl-10 h-12" placeholder="••••••••" required />
          </div>
        </div>
        <Button type="submit" className="w-full h-12" disabled={loading}>
          {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Logging in...</> : "Log in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
