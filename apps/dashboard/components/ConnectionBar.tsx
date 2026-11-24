"use client";

import { useEffect, useState } from "react";
import { getStoredConnection, storeConnection } from "../lib/api";

/** URL/key connection bar shown on every page. */
export default function ConnectionBar() {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const conn = getStoredConnection();
    setUrl(conn.url);
    setKey(conn.apiKey ?? "");
  }, []);

  const save = () => {
    storeConnection(url.trim(), key.trim() || undefined);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    window.location.reload();
  };

  return (
    <div
      className="panel"
      style={{ display: "flex", gap: 10, alignItems: "center" }}
    >
      <input
        style={{ flex: 2 }}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="API base URL (http://127.0.0.1:3001)"
        aria-label="API base URL"
      />
      <input
        style={{ flex: 1 }}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="API key (optional)"
        aria-label="API key"
        type="password"
      />
      <button onClick={save}>{saved ? "Saved ✓" : "Connect"}</button>
    </div>
  );
}
