import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuthActions, useMe } from "../hooks/useAuth";
import signinArt from "../assets/signin-illustration.svg";
import signupArt from "../assets/signup-illustration.svg";
import styles from "./LoginPage.module.css";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const { data: user } = useMe();
  const { login, register } = useAuthActions();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/requests";

  if (user) return <Navigate to={from} replace />;

  const action = mode === "login" ? login : register;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const done = { onSuccess: () => navigate(from, { replace: true }) };
    if (mode === "login") login.mutate({ email, password }, done);
    else register.mutate({ email, password, displayName }, done);
  };

  const isLogin = mode === "login";

  return (
    <div className={`${styles.split} ${isLogin ? "" : styles.reversed}`}>
      <aside className={`${styles.art} ${isLogin ? styles.artSignin : styles.artSignup}`}>
        <img src={isLogin ? signinArt : signupArt} alt="" />
        <h2>{isLogin ? "Welcome back" : "Your AI buying assistant"}</h2>
        <p>
          {isLogin
            ? "Pick up where you left off: review your sheets, approve a version and pay with PayPal."
            : "Describe what you need, let the agent source real products, then approve and pay in one place."}
        </p>
      </aside>
      <div className={styles.card}>
        <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
        <form className={styles.form} onSubmit={onSubmit}>
          {mode === "register" && (
            <label>
              Name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {action.error && <p className="error">{action.error.message}</p>}
          <button type="submit" className="primary" disabled={action.isPending}>
            {action.isPending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className={styles.switch}>
          {mode === "login" ? "New here? " : "Already have an account? "}
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              login.reset();
              register.reset();
            }}
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
