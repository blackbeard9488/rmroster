import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlus, Mail, Lock, Loader2 } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";
import { toast } from "@/components/ui/use-toast";

// Firebase - uses your existing repco-roster Firebase
// Make sure you have firebase compat loaded in your HTML:
// <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js"></script>

const FIREBASE_DB_URL = "https://repco-roster-default-rtdb.firebaseio.com";

// Local helpers - mirrors your existing roster storage
function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function safeSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Push to Firebase RTDB for sync
    if (window.firebase && window.firebase.database) {
      const db = window.firebase.database();
      // Save to repco_state for your roster system
      db.ref(`repco_state/${key}`).set(value).catch(()=>{});
      // Also save directly for redundancy
      fetch(`${FIREBASE_DB_URL}/${key}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
      }).catch(()=>{});
    }
  } catch (e) {
    console.error('safeSetJSON error', e);
  }
}

function getFirebaseAuth() {
  if (typeof window !== 'undefined' && window.firebase && window.firebase.auth) {
    return window.firebase.auth();
  }
  return null;
}

function getFirebaseDatabase() {
  if (typeof window !== 'undefined' && window.firebase && window.firebase.database) {
    return window.firebase.database();
  }
  return null;
}

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [pendingUser, setPendingUser] = useState(null);
  const navigate = useNavigate();

  // Your roster users key
  const USERS_KEY = "retail_roster_users_v1";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    try {
      const auth = getFirebaseAuth();
      const db = getFirebaseDatabase();

      // 1. Create user in Firebase Auth
      let firebaseUser = null;
      if (auth) {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        firebaseUser = cred.user;
        // Send email verification (replaces OTP in Firebase flow)
        await firebaseUser.sendEmailVerification().catch(()=>{});
        setPendingUser(firebaseUser);
      }

      // 2. Create user in your roster system (retail_roster_users_v1)
      const users = safeGetJSON(USERS_KEY, []);
      const username = email.split('@')[0]; // use email prefix as username for roster
      const exists = users.find(u => u.username.toLowerCase() === username.toLowerCase() || u.email?.toLowerCase() === email.toLowerCase());
      if (exists) {
        throw new Error("User already exists in roster");
      }

      const newRosterUser = {
        username: username,
        email: email,
        password: password, // for your existing roster login - you should hash in production
        firstName: username,
        lastName: "",
        displayName: username,
        role: "staff", // default role, admin can upgrade
        employmentType: "casual",
        isHidden: false,
        createdAt: Date.now(),
        firebaseUid: firebaseUser?.uid || null,
        emailVerified: false
      };

      const updatedUsers = [...users, newRosterUser];
      safeSetJSON(USERS_KEY, updatedUsers);

      // 3. Also save user profile to Firebase RTDB /users
      if (db) {
        const uid = firebaseUser?.uid || username;
        await db.ref(`users/${uid}`).set({
          email,
          username,
          role: "staff",
          createdAt: Date.now(),
          emailVerified: false
        });
        // Generate a simple 6-digit OTP and store in RTDB for verification (since you had OTP flow)
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        await db.ref(`otps/${uid}`).set({
          code: generatedOtp,
          email,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000 // 10 min
        });
        // In production, send via email function - for now log
        console.log('Generated OTP for', email, ':', generatedOtp);
        toast({
          title: "Verification code generated",
          description: `Code: ${generatedOtp} (check console - wire up email in production)`,
        });
      }

      // Show OTP screen (your existing flow)
      setShowOtp(true);
      
    } catch (err) {
      console.error(err);
      // Map Firebase errors to friendly messages
      let msg = err.message || "Registration failed";
      if (msg.includes("email-already-in-use")) msg = "Email already registered";
      if (msg.includes("invalid-email")) msg = "Invalid email address";
      if (msg.includes("weak-password")) msg = "Password too weak";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    setError("");
    setLoading(true);
    try {
      const db = getFirebaseDatabase();
      const auth = getFirebaseAuth();
      
      // Verify OTP from Firebase RTDB
      if (db && pendingUser) {
        const uid = pendingUser.uid;
        const snap = await db.ref(`otps/${uid}`).once('value');
        const otpData = snap.val();
        
        if (!otpData) {
          throw new Error("No verification code found. Please resend.");
        }
        if (Date.now() > otpData.expiresAt) {
          throw new Error("Code expired. Please resend.");
        }
        if (otpData.code !== otpCode) {
          throw new Error("Invalid verification code");
        }
        
        // Mark verified
        await db.ref(`users/${uid}`).update({ emailVerified: true });
        await db.ref(`otps/${uid}`).remove();
        
        // Update roster user as verified
        const users = safeGetJSON(USERS_KEY, []);
        const updated = users.map(u => {
          if (u.firebaseUid === uid || u.email === otpData.email) {
            return { ...u, emailVerified: true };
          }
          return u;
        });
        safeSetJSON(USERS_KEY, updated);
      }

      // Also check Firebase email verification if available
      if (auth && auth.currentUser) {
        await auth.currentUser.reload();
      }

      toast({
        title: "Account verified!",
        description: "You can now log in.",
      });
      
      // Redirect to login
      navigate("/login");
      
    } catch (err) {
      setError(err.message || "Invalid verification code");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    try {
      const db = getFirebaseDatabase();
      const auth = getFirebaseAuth();
      
      if (auth && pendingUser) {
        // Resend Firebase email verification
        await auth.currentUser?.sendEmailVerification().catch(()=>{});
      }
      
      if (db && pendingUser) {
        const uid = pendingUser.uid;
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        await db.ref(`otps/${uid}`).set({
          code: generatedOtp,
          email,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        console.log('Resent OTP for', email, ':', generatedOtp);
        toast({
          title: "Code sent",
          description: `New code: ${generatedOtp} - Check your email (console for now)`,
        });
      } else {
        toast({
          title: "Code sent",
          description: "Check your email for the new code.",
        });
      }
    } catch (err) {
      setError(err.message || "Failed to resend code");
    }
  };

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      const auth = getFirebaseAuth();
      const db = getFirebaseDatabase();
      
      if (!auth) throw new Error("Firebase Auth not initialized");
      
      const provider = new window.firebase.auth.GoogleAuthProvider();
      const result = await auth.signInWithPopup(provider);
      const firebaseUser = result.user;
      
      // Create roster user if not exists
      const users = safeGetJSON(USERS_KEY, []);
      const username = firebaseUser.email.split('@')[0];
      const exists = users.find(u => u.email?.toLowerCase() === firebaseUser.email.toLowerCase());
      
      if (!exists) {
        const newRosterUser = {
          username,
          email: firebaseUser.email,
          password: "", // Google users don't have password
          firstName: firebaseUser.displayName?.split(' ')[0] || username,
          lastName: firebaseUser.displayName?.split(' ').slice(1).join(' ') || "",
          displayName: firebaseUser.displayName || username,
          role: "staff",
          employmentType: "casual",
          isHidden: false,
          createdAt: Date.now(),
          firebaseUid: firebaseUser.uid,
          emailVerified: true,
          provider: "google",
          photoURL: firebaseUser.photoURL
        };
        safeSetJSON(USERS_KEY, [...users, newRosterUser]);
        
        if (db) {
          await db.ref(`users/${firebaseUser.uid}`).set({
            email: firebaseUser.email,
            username,
            displayName: firebaseUser.displayName,
            role: "staff",
            photoURL: firebaseUser.photoURL,
            provider: "google",
            createdAt: Date.now(),
            emailVerified: true
          });
        }
      }
      
      // Store session like your existing system
      localStorage.setItem('repco_username', firebaseUser.email.split('@')[0]);
      localStorage.setItem('repco_currentRole', 'staff');
      
      toast({
        title: "Signed in with Google",
        description: `Welcome ${firebaseUser.displayName || firebaseUser.email}`,
      });
      
      navigate("/");
      
    } catch (err) {
      console.error(err);
      setError(err.message || "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  if (showOtp) {
    return (
      <AuthLayout
        icon={Mail}
        title="Verify your email"
        subtitle={`We sent a code to ${email} - check Firebase console / email`}
      >
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-center mb-6">
          <InputOTP
            maxLength={6}
            value={otpCode}
            onChange={setOtpCode}
            autoFocus
            autoComplete="one-time-code"
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button
          className="w-full h-12 font-medium"
          onClick={handleVerify}
          disabled={loading || otpCode.length < 6}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Verifying...
            </>
          ) : (
            "Verify"
          )}
        </Button>
        <p className="text-center text-sm text-muted-foreground mt-4">
          Didn't receive the code?{" "}
          <button onClick={handleResend} className="text-primary font-medium hover:underline">
            Resend
          </button>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      icon={UserPlus}
      title="Create your account"
      subtitle="Sign up to get started - powered by Firebase"
      footer={
        <>
          Already have an account?{" "}
          <Link
            to={"/login"}
            className="text-primary font-medium hover:underline"
          >
            Log in
          </Link>
        </>
      }
    >
      <Button
        variant="outline"
        className="w-full h-12 text-sm font-medium mb-6"
        onClick={handleGoogle}
        disabled={loading}
      >
        <GoogleIcon className="w-5 h-5 mr-2" />
        Continue with Google
      </Button>

      <div className="relative mb-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-3 text-muted-foreground">or</span>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Creating account...
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
