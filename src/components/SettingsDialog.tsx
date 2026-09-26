"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { desktopApp, useDesktop, useDesktopInfo, type DesktopInfo, type DesktopSettings } from "@/lib/desktop";
import { formatAgo } from "@/lib/format";
import { DEFAULT_PREFS, requestNotifyPermission, sendTestNotification, setMuted, setNotifyPrefs, THRESHOLDS, useNotifyPrefs } from "@/lib/notify";
import { SITE } from "@/lib/site";
import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme";
import { toast, type SettingsSection } from "@/lib/ui";
import { engine, useUsage } from "@/lib/usage/engine";
import { Keys, Segmented, SettingRow, Switch } from "./Controls";
import { Icon, type IconName } from "./Icon";
import { Mark } from "./Logo";
import { CloseButton, Modal } from "./Modal";
import { GitHubGlyph } from "./ProviderLogo";
import { RefreshButton, useRefresh } from "./RefreshButton";

const SECTIONS: { id: SettingsSection; label: string; icon: IconName; desktopOnly?: boolean }[] = [
  { id: "general", label: "General", icon: "settings", desktopOnly: true },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard" },
  { id: "about", label: "About", icon: "info" },
];

/** Settings, like Windows 11's: sections on the left, cards on the right. */
export function SettingsDialog({ section, onClose }: { section: SettingsSection; onClose: () => void }) {
  const desktop = useDesktop();
  const titleId = useId();
  const sections = SECTIONS.filter((s) => desktop || !s.desktopOnly);
  const [current, setCurrent] = useState<SettingsSection>(sections.some((s) => s.id === section) ? section : sections[0].id);
  const shown = sections.find((s) => s.id === current) ?? sections[0];

  return (
    <Modal onClose={onClose} labelledBy={titleId} className="max-w-3xl overflow-hidden">
      <div className="flex h-[min(40rem,calc(100dvh-var(--tb-h)-2rem))] flex-col sm:flex-row">
        <nav aria-label="Settings sections" className="shrink-0 border-b border-line bg-panel-2 p-2 sm:w-56 sm:border-r sm:border-b-0">
          <h2 id={titleId} className="hidden px-2.5 pt-2 pb-3 text-base font-semibold text-fg sm:block">
            Settings
          </h2>
          <div role="tablist" aria-orientation="vertical" className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === shown.id}
                onClick={() => setCurrent(s.id)}
                className={`flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                  s.id === shown.id ? "bg-panel-3 font-medium text-fg" : "text-muted hover:bg-panel-3 hover:text-fg-2"
                }`}
              >
                <Icon name={s.icon} size={15} />
                {s.label}
              </button>
            ))}
          </div>
        </nav>
        <div role="tabpanel" aria-label={shown.label} className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h3 className="text-lg font-semibold text-fg">{shown.label}</h3>
            <CloseButton onClick={onClose} />
          </div>
          {shown.id === "general" && <GeneralSection />}
          {shown.id === "appearance" && <AppearanceSection />}
          {shown.id === "notifications" && <NotificationsSection />}
          {shown.id === "shortcuts" && <ShortcutsSection />}
          {shown.id === "about" && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}

// ---- General: what the desktop app's main process decides.

/** The system's words for where the app sits and when it starts. */
function systemWords(platform: string) {
  if (platform === "darwin") return { login: "Open at login", tray: "the Dock", system: "macOS" };
  if (platform === "win32") return { login: "Open when you sign in to Windows", tray: "the notification area", system: "Windows" };
  return { login: "Open at login", tray: "the tray", system: "your system" };
}

function GeneralSection() {
  const info = useDesktopInfo();
  if (!info) return <p className="text-sm text-muted">Asking the app…</p>;
  const words = systemWords(info.platform);
  const set = async <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => {
    const res = await desktopApp()?.setSetting(key, value);
    if (res && !res.ok) toast(res.error ?? "That could not be changed.", { tone: "error" });
  };

  return (
    <div className="space-y-2">
      <SettingRow
        title={words.login}
        description={info.installed ? `Starts in ${words.tray}, so limit notifications and scheduled hellos keep coming.` : "Only an installed copy can start by itself."}
      >
        <Switch checked={info.settings.openAtLogin} onChange={(on) => void set("openAtLogin", on)} disabled={!info.installed} label={words.login} />
      </SettingRow>
      {info.platform !== "darwin" && (
        <SettingRow title="Closing the window" description={`Keeping it running leaves it in ${words.tray}, still polling and notifying. Quit from its menu there.`}>
          <Segmented
            label="Closing the window"
            value={info.settings.closeToTray ? "tray" : "quit"}
            options={[
              { value: "tray", label: "Keeps it running" },
              { value: "quit", label: "Quits" },
            ]}
            onChange={(v) => void set("closeToTray", v === "tray")}
          />
        </SettingRow>
      )}
      <SettingRow title="Shortcut to show AI Cooldown" description="Works from any app: brings the window up, or hides it when it is already in front.">
        <ShortcutRecorder value={info.settings.shortcut} platform={info.platform} onChange={(v) => set("shortcut", v)} />
      </SettingRow>
      <SettingRow title="Data folder" description={<code className="font-mono text-[11px] break-all">{info.dataFolder}</code>}>
        <button type="button" onClick={() => void desktopApp()?.action("open-data-folder")} className="btn">
          <Icon name="folder" />
          Open
        </button>
      </SettingRow>
    </div>
  );
}

/** KeyboardEvent.code as an Electron accelerator key, or null for keys a global shortcut should not use. */
function acceleratorKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  return named[code] ?? null;
}

/** Records a global shortcut: press it while recording; Escape cancels, Backspace clears. */
function ShortcutRecorder({ value, platform, onChange }: { value: string | null; platform: string; onChange: (next: string | null) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const mac = platform === "darwin";

  function onKeyDown(e: React.KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setRecording(false);
      void onChange(null);
      return;
    }
    const key = acceleratorKey(e.code);
    // A key with at least Ctrl, Alt or the Windows/Command key, or it would fire while typing in other apps.
    if (!key || !(e.ctrlKey || e.altKey || e.metaKey)) return;
    const parts = [e.ctrlKey && (mac ? "Control" : "Ctrl"), e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && (mac ? "Command" : "Super"), key].filter(Boolean);
    setRecording(false);
    void onChange(parts.join("+"));
  }

  return (
    <>
      {value && !recording && <Keys keys={value} />}
      <button
        type="button"
        data-own-keys={recording || undefined}
        onClick={() => setRecording((r) => !r)}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
        className={`btn ${recording ? "btn-accent" : ""}`}
      >
        <Icon name="keyboard" />
        {recording ? "Press the keys…" : value ? "Change" : "Set shortcut"}
      </button>
      {value && !recording && (
        <button type="button" onClick={() => void onChange(null)} className="btn" aria-label="Remove the shortcut" title="Remove the shortcut">
          <Icon name="x" />
        </button>
      )}
    </>
  );
}

// ---- Appearance.

function AppearanceSection() {
  const pref = useThemePref();
  const desktop = useDesktop();
  return (
    <div className="space-y-2">
      <SettingRow title="Theme" description={`System follows ${desktop ? "your system" : "your device"} as it switches between light and dark.`}>
        <Segmented<ThemePref>
          label="Theme"
          value={pref}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={setThemePref}
        />
      </SettingRow>
      {desktop && (
        <SettingRow title="Zoom" description="Ctrl+Plus and Ctrl+Minus make everything bigger or smaller, Ctrl+0 goes back. The app remembers it." />
      )}
    </div>
  );
}

// ---- Notifications.

function NotificationsSection() {
  const desktop = useDesktop();
  const on = useUsage((s) => s.notify);
  const accounts = useUsage((s) => s.accounts);
  const prefs = useNotifyPrefs();
  const muted = accounts.filter((a) => prefs.muted.includes(a.id));
  const quiet = prefs.quiet ?? { from: "22:00", to: "08:00" };
  const time = "rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs text-fg focus:border-muted focus:outline-none";

  async function test() {
    const result = await requestNotifyPermission();
    if (result !== "granted") {
      toast(result === "denied" ? "Notifications are blocked for this site in your browser." : "This browser does not support notifications.", { tone: "error" });
      return;
    }
    sendTestNotification();
  }

  return (
    <div className="space-y-2">
      <SettingRow
        title="Notifications"
        description={desktop ? "System notifications, even while AI Cooldown sits in the tray. Clicking one opens it." : "Browser notifications while this tab is open."}
      >
        <Switch checked={on} onChange={() => void engine.toggleNotify()} label="Notifications" />
      </SettingRow>

      <div className={`space-y-2 ${on ? "" : "opacity-60"}`}>
        <p className="px-1 pt-3 text-xs font-medium text-muted">Tell me when</p>
        <SettingRow title="A limit resets" description="A window you had used at least 40% of comes back.">
          <Switch checked={prefs.reset} onChange={(v) => setNotifyPrefs({ reset: v })} label="A limit resets" />
        </SettingRow>
        <SettingRow title="A limit is nearly used up" description="A window crosses the share you pick.">
          <select
            value={prefs.threshold ?? DEFAULT_PREFS.threshold ?? 90}
            onChange={(e) => setNotifyPrefs({ threshold: Number(e.target.value) })}
            disabled={prefs.threshold === null}
            aria-label="Share used"
            className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-fg disabled:opacity-40"
          >
            {THRESHOLDS.map((t) => (
              <option key={t} value={t}>
                {t}% used
              </option>
            ))}
          </select>
          <Switch checked={prefs.threshold !== null} onChange={(v) => setNotifyPrefs({ threshold: v ? 90 : null })} label="A limit is nearly used up" />
        </SettingRow>
        <SettingRow title="A limit runs out" description="A window reaches 100%, with when it comes back.">
          <Switch checked={prefs.exhausted} onChange={(v) => setNotifyPrefs({ exhausted: v })} label="A limit runs out" />
        </SettingRow>

        <p className="px-1 pt-3 text-xs font-medium text-muted">Quiet</p>
        <SettingRow title="Quiet hours" description="Nothing about limits between these times, every day. What happens then still shows here.">
          <input type="time" value={quiet.from} disabled={!prefs.quiet} onChange={(e) => e.target.value && setNotifyPrefs({ quiet: { ...quiet, from: e.target.value } })} aria-label="Quiet from" className={time} />
          <span className="text-xs text-faint">to</span>
          <input type="time" value={quiet.to} disabled={!prefs.quiet} onChange={(e) => e.target.value && setNotifyPrefs({ quiet: { ...quiet, to: e.target.value } })} aria-label="Quiet until" className={time} />
          <Switch checked={prefs.quiet !== null} onChange={(v) => setNotifyPrefs({ quiet: v ? quiet : null })} label="Quiet hours" />
        </SettingRow>
        <SettingRow
          title="Muted accounts"
          description={muted.length ? "Nothing is sent about these. Mute or unmute an account from its ⋯ menu." : "None. Mute an account from its ⋯ menu to hear nothing about it."}
        >
          {muted.map((a) => (
            <button key={a.id} type="button" onClick={() => setMuted(a.id, false)} className="btn" title={`Unmute ${a.label}`}>
              <Icon name="bellOff" />
              {a.label}
            </button>
          ))}
        </SettingRow>
      </div>

      <div className="pt-3">
        <button type="button" onClick={() => void test()} className="btn">
          <Icon name="bell" />
          Send a test notification
        </button>
      </div>
    </div>
  );
}

// ---- Keyboard shortcuts.

const SHORTCUTS: { keys: string; what: string; desktopOnly?: boolean }[] = [
  { keys: "Ctrl+K", what: "Search accounts and run a command" },
  { keys: "Ctrl+,", what: "Settings" },
  { keys: "?", what: "These shortcuts" },
  { keys: "Esc", what: "Close a dialog or menu" },
  { keys: "Ctrl+R", what: "Refresh (also F5)", desktopOnly: true },
  { keys: "Ctrl+N", what: "Add an account", desktopOnly: true },
  { keys: "Ctrl+Shift+C", what: "Copy the status of every account", desktopOnly: true },
  { keys: "Ctrl+1", what: "Dashboard", desktopOnly: true },
  { keys: "Ctrl+2", what: "Team", desktopOnly: true },
  { keys: "Ctrl+Plus", what: "Zoom in (Ctrl+Minus zooms out, Ctrl+0 resets)", desktopOnly: true },
  { keys: "F11", what: "Full screen", desktopOnly: true },
  { keys: "Ctrl+Shift+R", what: "Reload the window", desktopOnly: true },
  { keys: "Ctrl+W", what: "Close the window", desktopOnly: true },
  { keys: "Ctrl+Q", what: "Quit AI Cooldown", desktopOnly: true },
];

function ShortcutsSection() {
  const desktop = useDesktop();
  const info = useDesktopInfo();
  const mac = desktop ? info?.platform === "darwin" : typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const shown = SHORTCUTS.filter((s) => desktop || !s.desktopOnly);
  return (
    <div>
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel-2">
        {shown.map((s) => (
          <li key={s.keys} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <span className="text-fg-2">{s.what}</span>
            <Keys keys={mac ? s.keys.replace("Ctrl", "⌘") : s.keys} />
          </li>
        ))}
      </ul>
      {!desktop && <p className="mt-3 text-xs text-muted">The desktop app adds shortcuts for refreshing, adding accounts and moving between pages, which a browser keeps for itself.</p>}
    </div>
  );
}

// ---- About.

function AboutSection() {
  const info = useDesktopInfo();
  const link = "btn";
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <Mark size={56} animated />
        <div className="min-w-0">
          <p className="text-lg font-semibold text-fg">{SITE.name}</p>
          <p className="text-sm text-muted">{SITE.tagline}</p>
          {info && <p className="mt-1 font-mono text-[11px] text-faint">Version {info.version}</p>}
        </div>
      </div>
      {info && <UpdateRow info={info} />}
      <div className="flex flex-wrap gap-2">
        <a href={`${SITE.repo}/releases`} target="_blank" rel="noopener noreferrer" className={link}>
          <Icon name="external" />
          What&apos;s new
        </a>
        <a href={SITE.repo} target="_blank" rel="noopener noreferrer" className={link}>
          <GitHubGlyph size={13} />
          Star on GitHub
        </a>
        <a href={`${SITE.repo}/issues/new`} target="_blank" rel="noopener noreferrer" className={link}>
          <Icon name="info" />
          Report a problem
        </a>
        {info ? (
          <a href={`https://${SITE.domain}/guides`} target="_blank" rel="noopener noreferrer" className={link}>
            <Icon name="link" />
            Guides
          </a>
        ) : (
          <Link href="/guides" className={link}>
            <Icon name="link" />
            Guides
          </Link>
        )}
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Free and open source under the MIT license. Not affiliated with Anthropic or OpenAI; the Claude and OpenAI marks identify each provider and belong to their owners.
      </p>
    </div>
  );
}

function UpdateRow({ info }: { info: DesktopInfo }) {
  const { update } = info;
  const bridge = desktopApp();
  const [now] = useState(() => Date.now());
  const [asking, check] = useRefresh(async () => {
    await bridge?.action("check-updates");
  });
  const checking = asking || update.state === "checking";
  let text: string;
  let button: React.ReactNode = null;
  if (update.state === "ready") {
    text = `Version ${update.version} is downloaded and installs when the window closes.`;
    button = (
      <button type="button" onClick={() => void bridge?.action("install-update")} className="btn btn-primary">
        Restart to update
      </button>
    );
  } else if (update.state === "available") {
    text = `Version ${update.version} is out.`;
    button = (
      <button type="button" onClick={() => void bridge?.action("install-update")} className="btn btn-primary">
        Download
      </button>
    );
  } else if (update.state === "downloading") text = `Downloading version ${update.version}…`;
  else if (!info.installed && !checking) text = "This copy is not installed, so it does not update itself.";
  else {
    // The button stays where it is while it checks, turning.
    text = checking
      ? "Checking for updates…"
      : update.error
        ? `The last check failed: ${update.error}`
        : update.checkedAt
          ? `Up to date. Checked ${formatAgo(Math.max(0, now - update.checkedAt))}.`
          : "Checks for updates every few hours.";
    button = <RefreshButton text="Check for updates" label="Check for updates" busy={checking} onRefresh={() => void check()} />;
  }
  return (
    <SettingRow title="Updates" description={text}>
      {button}
    </SettingRow>
  );
}
