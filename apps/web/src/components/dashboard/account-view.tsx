import { createEffect, createSignal, Show } from 'solid-js';
import { useAuth } from '@/context/auth';
import { Button } from '@/components/ui/button';
import { DashboardScrollView, DashboardSurfaceSection } from './shared';

export function DashboardAccountView() {
  const auth = useAuth();
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  createEffect(() => setName(auth.user()?.name ?? ''));
  const run = async (action: () => Promise<void>, success = '') => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <DashboardScrollView>
      <h1 class="text-2xl">Account</h1>
      <DashboardSurfaceSection title="Profile">
        <p class="text-sm">{auth.user()?.email}</p>
        <form
          class="flex items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => auth.updateProfile(name().trim()), 'Profile saved.');
          }}
        >
          <label class="flex flex-1 flex-col gap-2 text-xs">
            Name
            <input
              class="rounded-md border border-border bg-input p-2"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              maxLength={100}
              required
            />
          </label>
          <Button type="submit" disabled={busy() || !name().trim()}>
            Save
          </Button>
        </form>
      </DashboardSurfaceSection>
      <Show when={message()}>
        <p role="status" class="text-sm">
          {message()}
        </p>
      </Show>
      <DashboardSurfaceSection title="Session">
        <Button variant="secondary" disabled={busy()} onClick={() => void run(auth.signOut)}>
          Sign out
        </Button>
      </DashboardSurfaceSection>
      <DashboardSurfaceSection title="Delete account">
        <p class="text-xs text-muted-foreground">
          Deletes your account and cloud upload records. Project files on your computer remain
          available. Temporary media is scheduled for deletion after 24 hours.
        </p>
        <Show
          when={confirmDelete()}
          fallback={
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              Delete account…
            </Button>
          }
        >
          <p class="text-sm">
            Permanently delete this account? You may need to sign in again if your session is no
            longer fresh.
          </p>
          <div class="flex gap-2">
            <Button disabled={busy()} onClick={() => void run(auth.deleteAccount)}>
              Delete permanently
            </Button>
            <Button variant="secondary" disabled={busy()} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </Show>
      </DashboardSurfaceSection>
    </DashboardScrollView>
  );
}
