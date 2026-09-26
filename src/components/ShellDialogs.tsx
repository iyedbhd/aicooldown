"use client";

import { closeShell, toast, useShellDialog } from "@/lib/ui";
import { engine, useUsage } from "@/lib/usage/engine";
import { AccountDialog } from "./AccountDialog";
import { AddAccountDialog } from "./AddAccountDialog";
import { AuthDialog } from "./AuthDialog";
import { CommandPalette } from "./CommandPalette";
import { SettingsDialog } from "./SettingsDialog";

/**
 * The shell's dialogs, one at a time, on any page: the command palette,
 * Settings, and the account dialogs (so Ctrl+N or the tray's "Add account"
 * work from the Team page too). Loaded the first time one opens.
 */
export function ShellDialogs() {
  const dialog = useShellDialog();
  const user = useUsage((s) => s.user);
  const linked = useUsage((s) => s.accounts.length);

  if (dialog === "palette") return <CommandPalette onClose={closeShell} />;
  if (dialog === "add")
    return (
      <AddAccountDialog
        onAdd={async (account) => {
          await engine.add(account);
          closeShell();
        }}
        onClose={closeShell}
      />
    );
  // Signing in is announced; the engine switches to the account's accounts and offers to move guest ones.
  if (dialog === "auth") return <AuthDialog onSignedIn={closeShell} onClose={closeShell} localCount={linked} />;
  if (dialog === "account" && user)
    return (
      <AccountDialog
        user={user}
        linkedCount={linked}
        onClose={closeShell}
        onNote={(text) => {
          toast(text);
          closeShell();
        }}
        onDeleted={() => {
          closeShell();
          void engine.accountDeleted();
        }}
      />
    );
  if (dialog && typeof dialog === "object") return <SettingsDialog key={dialog.settings} section={dialog.settings} onClose={closeShell} />;
  return null;
}
