import { useEffect, useState } from "react";
import { parseWebVtt, type SubtitleCue } from "@/lib/player/webvtt";

interface SubtitleOverlayProps {
  url: string | null;
  position: number;
  generation: number;
}

export function SubtitleOverlay({ url, position, generation }: SubtitleOverlayProps) {
  const key = `${generation}:${url ?? ""}`;
  const [resource, setResource] = useState<{ key: string; cues: SubtitleCue[]; error?: string }>({ key: "", cues: [] });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResource({ key, cues: [] });
    if (url) {
      void (async () => {
        try {
          const target = new URL(url, window.location.href);
          if (target.origin !== window.location.origin) throw new Error("字幕地址必须与当前页面同源。");
          const response = await fetch(target, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "登录状态已失效，无法读取字幕。" : "字幕加载失败，请重新选择字幕轨。");
          const cues = parseWebVtt(await response.text());
          if (active && !controller.signal.aborted) setResource({ key, cues });
        } catch (error) {
          if (active && !controller.signal.aborted) setResource({ key, cues: [], error: error instanceof Error ? error.message : "字幕加载失败。" });
        }
      })();
    }
    return () => { active = false; controller.abort(); };
  }, [url, generation, key]);

  if (!url || resource.key !== key) return null;
  if (resource.error) return <div className="player-subtitle-error" role="status">{resource.error}</div>;
  const visible = resource.cues.filter((cue) => cue.start <= position && position < cue.end);
  return <div className="player-subtitles" aria-live="off">
    {visible.map((cue, index) => <span className="player-subtitle-cue" key={`${cue.start}:${cue.end}:${index}`}>{cue.text}</span>)}
  </div>;
}
