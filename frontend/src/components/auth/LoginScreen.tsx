import React, { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { readError } from "@/lib/api"

interface LoginScreenProps {
  mode: "setup" | "login"
  onSuccess: (username: string) => void
}

/**
 *  - login: username + password
 *  - setup: first run (no account yet) — setup code from the server log,
 *    username, password, confirm password
 */
export const LoginScreen: React.FC<LoginScreenProps> = ({ mode, onSuccess }) => {
  const isSetup = mode === "setup"
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [setupCode, setSetupCode] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isSetup && password !== confirm) {
      setError("Passwords don't match.")
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(isSetup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isSetup ? { username, password, setup_code: setupCode } : { username, password }
        ),
      })
      if (res.ok) {
        const data: { username: string } = await res.json()
        setPassword("")
        setConfirm("")
        onSuccess(data.username)
      } else {
        setError(await readError(res, `Sign-in failed (${res.status})`))
        setPassword("")
        setConfirm("")
      }
    } catch {
      setError("Can't reach OpenShelf. Is the backend running?")
    } finally {
      setSubmitting(false)
    }
  }

  const field =
    "w-full h-12 px-3 bg-transparent border border-foreground text-[15px] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground"
  const label = "block text-sm font-semibold mb-1.5"

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
      <main className="flex-1 flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <img
            src="/logo.png"
            alt=""
            width={280}
            height={244}
            className="block mx-auto w-[220px] h-auto mb-5"
          />
          <p className="font-serif text-3xl font-bold tracking-tight text-center">OpenShelf</p>
          <p className="text-center text-xs uppercase tracking-[0.2em] text-muted-foreground mt-1">
            Your home library
          </p>

          <div className="mt-10 border-t-2 border-foreground pt-6">
            <h1 className="font-serif text-2xl font-bold">
              {isSetup ? "Set up your library" : "Sign in"}
            </h1>
            {isSetup && (
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                Create the account you'll use to sign in to this OpenShelf.
              </p>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
              {isSetup && (
                <div>
                  <label htmlFor="setup-code" className={label}>
                    Setup code
                  </label>
                  <input
                    id="setup-code"
                    value={setupCode}
                    onChange={(e) => setSetupCode(e.target.value.toUpperCase())}
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    autoFocus
                    required
                    placeholder="XXXX-XXXX"
                    className={`${field} font-mono tracking-widest`}
                  />
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                    Shown in the server log when OpenShelf starts. With Docker, run{" "}
                    <code className="font-mono">docker logs openshelf</code>, or open the
                    container's <strong>Logs</strong> in Portainer or your NAS app. A new code is
                    made every time OpenShelf restarts, so use the newest one.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="username" className={label}>
                  Username
                </label>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={!isSetup}
                  required
                  className={field}
                />
              </div>

              <div>
                <label htmlFor="password" className={label}>
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={isSetup ? "new-password" : "current-password"}
                    required
                    className={`${field} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-0 top-0 h-12 w-12 flex items-center justify-center hover:bg-accent"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {isSetup && (
                  <p className="text-xs text-muted-foreground mt-1.5">At least 8 characters.</p>
                )}
              </div>

              {isSetup && (
                <div>
                  <label htmlFor="confirm" className={label}>
                    Confirm password
                  </label>
                  <input
                    id="confirm"
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                    className={field}
                  />
                </div>
              )}

              {error && (
                <div role="alert" className="border-2 border-foreground p-3 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !username || !password || (isSetup && !setupCode)}
                className="w-full h-12 eink-selected font-bold text-[15px] hover:opacity-90 disabled:opacity-40"
              >
                {submitting
                  ? isSetup
                    ? "Creating account…"
                    : "Signing in…"
                  : isSetup
                  ? "Create account"
                  : "Sign in"}
              </button>
            </form>
          </div>
        </div>
      </main>
      <footer className="text-center text-[11px] text-muted-foreground pb-6">
        OpenShelf · self-hosted
      </footer>
    </div>
  )
}
