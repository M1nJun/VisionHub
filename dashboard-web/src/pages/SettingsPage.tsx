import { useEffect, useState } from "react";
import { fetchSettings, updateSetting } from "../api";
import type { Setting } from "../types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const list = await fetchSettings();
    setSettings(list);
    setDrafts(Object.fromEntries(list.map((s) => [s.key, s.value])));
    setLoading(false);
  }

  async function save(key: string) {
    setSavingKey(key);
    setMessage(null);
    try {
      await updateSetting(key, drafts[key]);
      await load();
      setMessage({ key, text: "Saved", ok: true });
    } catch (e) {
      setMessage({ key, text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return <div className="page empty-state">Loading...</div>;
  }

  return (
    <div className="page">
      <div className="panel">
        <h2>Dashboard Settings</h2>
        <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -4 }}>
          Changes apply immediately - no restart needed.
        </p>
        {settings.map((s) => (
          <div className="settings-row" key={s.key}>
            <div>
              <div className="key">{s.key}</div>
              {s.description && <div className="desc">{s.description}</div>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {message?.key === s.key && (
                <span style={{ fontSize: 12, color: message.ok ? "var(--green)" : "var(--red)" }}>
                  {message.text}
                </span>
              )}
              <input
                value={drafts[s.key] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
              />
              <button
                className="btn"
                disabled={savingKey === s.key || drafts[s.key] === s.value}
                onClick={() => save(s.key)}
              >
                {savingKey === s.key ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
