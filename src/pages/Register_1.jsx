import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Lock, Loader2, UserPlus } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import AuthLayout from "@/components/AuthLayout";
import { toast } from "@/components/ui/use-toast";

const FIREBASE_DB_URL = "https://repco-roster-default-rtdb.firebaseio.com";
const USERS_KEY = "retail_roster_users_v1";

function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function safeSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Push to Firebase RTDB - all data through your Firebase
    if (window.firebase && window.firebase.database) {
      const db = window.firebase.database();
      db.ref(`repco_state/${key}`).set(value).catch(()=>{});
    }
    fetch(`${FIREBASE_DB_URL}/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    }).catch(()=>{});
  } catch (e) {
    console.error('safeSetJSON error', e);
  }
}

export default function Register() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [generatedOtp, setGeneratedOtp] = useState("");
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setError("Username is required");
      return;
    }
    if (cleanUsername.length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 3) {
      setError("Password must be at least 3 characters");
      return;
    }
    setLoading(true);
    try {
      const users = safeGetJSON(USERS_KEY, []);
      const exists = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
      if (exists) {
        throw new Error("Username already taken");
      }

      // Generate OTP - store in Firebase RTDB
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      setGeneratedOtp(otp);

      // Save pending user in Firebase RTDB
      const db = window.firebase?.database?.();
      if (db) {
        await db.ref(`otps/${cleanUsername.toLowerCase()}`).set({
          code: otp,
          username: cleanUsername,
          firstName,
          lastName,
          password,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        // Also save to /users_pending
        await db.ref(`users_pending/${cleanUsername.toLowerCase()}`).set({
          username: cleanUsername,
          firstName: firstName || cleanUsername,
          lastName: lastName || "",
          password,
          role: "staff",
          createdAt: Date.now()
        });
      }

      console.log('OTP for', cleanUsername, ':', otp);
      toast({
        title: "Verification code",
        description: `Code for ${cleanUsername}: ${otp} (wire to your system)`,
      });

      setShowOtp(true);
    } catch (err) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setError("");
    setLoading(true);
    try {
      const db = window.firebase?.database?.();
      let otpData = null;
      
      if (db) {
        const snap = await db.ref(`otps/${username.toLowerCase()}`).once('value');
        otpData = snap.val();
        if (!otpData) throw new Error("No code found. Please resend.");
        if (Date.now() > otpData.expiresAt) throw new Error("Code expired. Please resend.");
        if (otpData.code !== otpCode) throw new Error("Invalid code");
      } else {
        // Fallback local check
        if (otpCode !== generatedOtp) throw new Error("Invalid code");
      }

      // Create final user in roster
      const users = safeGetJSON(USERS_KEY, []);
      const newUser = {
        username: username.trim(),
        password: password,
        firstName: firstName.trim() || username.trim(),
        lastName: lastName.trim() || "",
        displayName: (firstName.trim() + " " + lastName.trim()).trim() || username.trim(),
        role: "staff",
        employmentType: "casual",
        isHidden: false,
        createdAt: Date.now(),
        usernameLower: username.toLowerCase()
      };

      const updated = [...users, newUser];
      safeSetJSON(USERS_KEY, updated);

      // Save to Firebase users node
      if (db) {
        await db.ref(`users/${username.toLowerCase()}`).set({
          username: newUser.username,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          displayName: newUser.displayName,
          role: "staff",
          employmentType: "casual",
          createdAt: Date.now()
        });
        // Clean up otp and pending
        await db.ref(`otps/${username.toLowerCase()}`).remove();
        await db.ref(`users_pending/${username.toLowerCase()}`).remove();
      }

      toast({ title: "Account created!", description: `Welcome ${newUser.username}` });
      navigate("/login");
    } catch (err) {
      setError(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      setGeneratedOtp(otp);
      const db = window.firebase?.database?.();
      if (db) {
        await db.ref(`otps/${username.toLowerCase()}`).set({
          code: otp,
          username,
          firstName,
          lastName,
          password,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000
        });
      }
      console.log('Resent OTP for', username, ':', otp);
      toast({ title: "Code resent", description: `New code: ${otp}` });
    } catch (err) {
      setError("Failed to resend");
    }
  };

  if (showOtp) {
    return (
      <AuthLayout icon={UserPlus} title="Verify username" subtitle={`Code for ${username}`}>
        {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
        <div className="flex justify-center mb-6">
          <InputOTP maxLength={6} value={otpCode} onChange={setOtpCode} autoFocus>
            <InputOTPGroup>
              <InputOTPSlot index={0} /><InputOTPSlot index={1} /><InputOTPSlot index={2} />
              <InputOTPSlot index={3} /><InputOTPSlot index={4} /><InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button className="w-full h-12" onClick={handleVerify} disabled={loading || otpCode.length < 6}>
          {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</> : "Verify & Create"}
        </Button>
        <p className="text-center text-sm text-muted-foreground mt-4">
          Didn't get code? <button onClick={handleResend} className="text-primary font-medium hover:underline">Resend</button>
        </p>
        <p className="text-center text-xs text-muted-foreground mt-2">Check console - OTP: {generatedOtp}</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      icon={UserPlus}
      title="Create account"
      subtitle="Username only - no email needed"
      footer={<>Already have an account? <Link to="/login" className="text-primary font-medium hover:underline">Log in</Link></>}
    >
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>First Name</Label>
            <Input value={firstName} onChange={e=>setFirstName(e.target.value)} placeholder="John" className="h-12" />
          </div>
          <div className="space-y-2">
            <Label>Last Name</Label>
            <Input value={lastName} onChange={e=>setLastName(e.target.value)} placeholder="Smith" className="h-12" />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Username *</Label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={username} onChange={e=>setUsername(e.target.value)} className="pl-10 h-12" placeholder="johndoe" required autoFocus />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Password *</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="pl-10 h-12" placeholder="••••••••" required />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Confirm Password *</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="pl-10 h-12" placeholder="••••••••" required />
          </div>
        </div>
        <Button type="submit" className="w-full h-12" disabled={loading}>
          {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating...</> : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
