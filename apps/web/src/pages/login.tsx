import { createSignal, Show } from 'solid-js';
import { useAuth } from '@/context/auth';
import { Button } from '@/components/ui/button';
import { TextField, TextFieldInput, TextFieldLabel } from '@/components/ui/text-field';
import { Icon } from '@/components/ui/icon';
import { useFullscreenState } from '@/hooks/use-fullscreen-state';
export function LoginPage() {
  const auth = useAuth();
  const isFullscreen = useFullscreenState();
  const [email, setEmail] = createSignal('');
  const [code, setCode] = createSignal('');
  const [sent, setSent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (sent()) await auth.verifyCode(email().trim(), code().trim());
      else {
        await auth.sendCode(email().trim());
        setSent(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="fixed inset-0 z-999 flex items-center justify-center bg-background">
      <Show when={!!window.desktop && !isFullscreen()}>
        <div class="absolute inset-x-0 top-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <form class="w-80 space-y-4 rounded-xl bg-accent/40 p-6" onSubmit={submit}>
        <Icon name="compound-logo" class="size-10 rounded-lg" />
        <h1 class="text-lg font-medium">Sign in to Compound</h1>
        <p class="text-sm text-muted-foreground">
          {sent()
            ? 'Enter the code from your email.'
            : 'We’ll email you a code. New accounts are created automatically.'}
        </p>
        <TextField>
          <TextFieldLabel>Email</TextFieldLabel>
          <TextFieldInput
            type="email"
            autocomplete="email"
            required
            disabled={sent()}
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </TextField>
        <Show when={sent()}>
          <TextField>
            <TextFieldLabel>Verification code</TextFieldLabel>
            <TextFieldInput
              autocomplete="one-time-code"
              inputmode="numeric"
              pattern="[0-9]{6}"
              required
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </TextField>
        </Show>
        <Show when={error() || auth.error()}>
          <p role="alert" class="text-sm text-destructive">
            {error() || auth.error()}
          </p>
        </Show>
        <Button type="submit" class="w-full" disabled={busy()}>
          {busy() ? 'Please wait…' : sent() ? 'Verify code' : 'Send code'}
        </Button>
        <Show when={sent()}>
          <Button
            type="button"
            variant="ghost"
            disabled={busy()}
            onClick={() => {
              setSent(false);
              setCode('');
            }}
          >
            Change email or resend code
          </Button>
        </Show>
      </form>
    </div>
  );
}
