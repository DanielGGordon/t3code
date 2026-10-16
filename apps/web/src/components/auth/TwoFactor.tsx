import { useEffect, useState, type ReactNode } from "react";
import * as Effect from "effect/Effect";
import { AuthAccessWriteScope } from "@t3tools/contracts";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { fetchSessionState } from "../../environments/primary/auth";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { searchableSetting } from "../settings/settingsSearch";
import { SettingsSection } from "../settings/settingsLayout";

function request(action: "status" | "begin" | "confirm" | "verify" | "disable", code?: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.twoFactor({
          headers: {},
          payload: { action, ...(code === undefined ? {} : { code }) },
        }),
      ),
    ),
  );
}

function CodeForm({
  action,
  onSuccess,
}: {
  action: "confirm" | "verify" | "disable";
  onSuccess: (result: Awaited<ReturnType<typeof request>>) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void request(action, code.trim())
          .then((result) => {
            if (result.error) setError(result.error);
            else {
              setCode("");
              onSuccess(result);
            }
          })
          .catch(() => setError("Could not verify. Check your connection and try again."))
          .finally(() => setBusy(false));
      }}
    >
      <label className="block text-sm" htmlFor={`two-factor-${action}`}>
        {action === "confirm" ? "Authenticator code" : "Authenticator or recovery code"}
      </label>
      <Input
        id={`two-factor-${action}`}
        nativeInput
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        disabled={busy}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !code.trim()}>
        {busy
          ? "Verifying…"
          : action === "disable"
            ? "Disable two-factor authentication"
            : "Verify"}
      </Button>
    </form>
  );
}

/** Re-check on focus and at the server's absolute deadline; activity never renews it. */
export function TwoFactorGate({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof request>>["status"] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      void fetchSessionState()
        .then((session) => {
          const result = {
            status: session.twoFactor ?? { enabled: false, required: false, expiresAt: null },
          };
          if (disposed) return;
          setStatus(result.status);
          setError(false);
          clearTimeout(timer);
          const untilExpiry =
            result.status.expiresAt === null ? 60_000 : result.status.expiresAt - Date.now();
          timer = setTimeout(
            refresh,
            result.status.required ? 60_000 : Math.max(1, Math.min(60_000, untilExpiry)),
          );
        })
        .catch(() => {
          if (!disposed) {
            setError(true);
            timer = setTimeout(refresh, 5000);
          }
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled]);
  if (!enabled) return children;
  if (status === null || status.required || error)
    return (
      <StandalonePage tone="pairing">
        <StandalonePageHeader
          eyebrow="T3 Code"
          title={status?.required ? "Verify your session" : "Checking session security"}
          description={
            status?.required
              ? "Enter a code from your authenticator app. Each session needs verification every 48 hours."
              : "Connecting to this environment."
          }
        />
        <div className="mt-6 space-y-4">
          {error && <p role="alert">Could not check session security. Retrying…</p>}
          {status?.required && (
            <CodeForm action="verify" onSuccess={() => window.location.reload()} />
          )}
        </div>
      </StandalonePage>
    );
  return children;
}

export function TwoFactorSettings() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof request>> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [disable, setDisable] = useState(false);
  useEffect(() => {
    void Promise.all([request("status"), fetchSessionState()])
      .then(([result, session]) => {
        setResult(result);
        setCanManage(session.scopes?.includes(AuthAccessWriteScope) ?? false);
      })
      .catch(() => setError("Could not load two-factor settings."));
  }, []);
  return (
    <SettingsSection {...searchableSetting("two-factor-authentication")}>
      <div className="space-y-4 p-4 text-sm">
        <p>
          {result?.status.enabled
            ? "Enabled. Every session must verify with your authenticator every 48 hours."
            : "Protect this environment with an authenticator app. Enabling this prompts all other sessions for a code."}
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {result?.recoveryCodes && (
          <div className="space-y-2">
            <p className="font-medium">
              Save these recovery codes now. Each works once and they will not be shown again.
            </p>
            <pre className="select-all overflow-auto rounded border p-3 text-xs">
              {result.recoveryCodes.join("\n")}
            </pre>
            <Button variant="outline" onClick={() => setResult({ status: result.status })}>
              I saved my recovery codes
            </Button>
          </div>
        )}
        {result?.uri && (
          <>
            <p>
              Scan this QR code in your authenticator, or enter the setup key manually. Setup
              expires after ten minutes.
            </p>
            <QRCodeSvg value={result.uri} size={180} title="Authenticator setup" />
            <p className="break-all font-mono select-all">{result.secret}</p>
            <CodeForm action="confirm" onSuccess={setResult} />
            <Button variant="outline" onClick={() => setResult({ status: result.status })}>
              Cancel setup
            </Button>
          </>
        )}
        {result &&
          canManage &&
          !result.uri &&
          !result.recoveryCodes &&
          (!result.status.enabled ? (
            <Button
              onClick={() => {
                void request("begin")
                  .then((next) => {
                    if (next.error) setError(next.error);
                    else setResult(next);
                  })
                  .catch(() => setError("Could not start setup."));
              }}
            >
              Set up authenticator
            </Button>
          ) : disable ? (
            <>
              <CodeForm
                action="disable"
                onSuccess={(next) => {
                  setResult(next);
                  setDisable(false);
                }}
              />
              <Button variant="outline" onClick={() => setDisable(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setDisable(true)}>
              Disable two-factor authentication…
            </Button>
          ))}
      </div>
    </SettingsSection>
  );
}
