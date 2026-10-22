import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Film, ListVideo, LoaderCircle, Play, RefreshCw, X } from "lucide-react";
import type { ShowEpisode, ShowLibrary } from "@/lib/api";

export interface PlayerEpisodesProps {
  library?: ShowLibrary;
  mediaId: string;
  showTitle: string;
  artwork?: string;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onClose: () => void;
  onSelect: (mediaId: string) => void;
}

export function episodeLabel(item: ShowEpisode): string {
  if (item.episode_start == null) {
    return item.season == null ? "影片" : item.season === 0 ? "特别篇" : "未标记集数";
  }
  const number = item.episode_end != null && item.episode_end > item.episode_start
    ? `${item.episode_start}–${item.episode_end}`
    : `${item.episode_start}`;
  return `${item.season === 0 ? "特别篇 · " : ""}第 ${number} 集`;
}

function seasonKey(season: number | null): string {
  return season == null ? "movie" : String(season);
}

function seasonLabel(season: number | null): string {
  return season == null ? "影片" : season === 0 ? "特别篇" : `第 ${season} 季`;
}

function EpisodeArtwork({ item, artwork, current }: { item: ShowEpisode; artwork?: string; current: boolean }) {
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const src = [item.thumbnail_url, artwork].find((candidate) => candidate && !failedSources.includes(candidate));
  const progress = item.progress && item.progress.duration > 0
    ? Math.min(100, Math.max(0, item.progress.position / item.progress.duration * 100))
    : 0;

  return <span className="player-episode-artwork" aria-hidden="true">
    {src
      ? <img src={src} alt="" loading="lazy" onError={() => setFailedSources((previous) => [...previous, src])} />
      : <Film className="player-episode-artwork-placeholder" size={25} />}
    <span className="player-episode-play"><Play size={18} fill="currentColor" /></span>
    {current && <span className="player-episode-playing"><span /><span /><span /></span>}
    {item.progress?.completed
      ? <span className="player-episode-watched"><Check size={12} /></span>
      : progress > 0 && <span className="player-episode-progress"><span style={{ width: `${progress}%` }} /></span>}
  </span>;
}

export function PlayerEpisodes(props: PlayerEpisodesProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const currentItemRef = useRef<HTMLButtonElement>(null);
  const seasonId = useId();
  const titleId = useId();
  const seasons = props.library?.seasons ?? [];
  const currentSeason = seasons.find((season) => season.items.some((item) => item.media_id === props.mediaId));
  const currentSeasonKey = currentSeason ? seasonKey(currentSeason.season) : undefined;
  const [selectedSeasonKey, setSelectedSeasonKey] = useState(currentSeasonKey);
  const selectedSeason = seasons.find((season) => seasonKey(season.season) === selectedSeasonKey) ?? currentSeason ?? seasons[0];
  const selectedKey = selectedSeason ? seasonKey(selectedSeason.season) : undefined;
  const playableCount = selectedSeason?.items.filter((item) => item.media_id && !item.rename_pending).length ?? 0;

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setSelectedSeasonKey(currentSeasonKey);
  }, [currentSeasonKey, props.mediaId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => currentItemRef.current?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedKey, props.mediaId, props.loading, props.error]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || active === panelRef.current)) {
      event.preventDefault();
      first?.focus();
    }
  }

  return <section
    ref={panelRef}
    id="player-episodes-panel"
    className="player-episodes-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-busy={props.loading}
    tabIndex={-1}
    onKeyDown={handleKeyDown}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <header className="player-episodes-header">
      <div>
        <span className="player-episodes-eyebrow">播放列表</span>
        <h2 id={titleId}><ListVideo size={20} aria-hidden="true" />选集</h2>
        <p title={props.showTitle}>{props.showTitle}</p>
      </div>
      <button ref={closeButtonRef} className="player-icon-button player-episodes-close" type="button" onClick={props.onClose} aria-label="关闭选集" title="关闭选集（Esc）"><X size={20} aria-hidden="true" /></button>
    </header>

    {!props.loading && !props.error && selectedSeason && <div className="player-episodes-tools">
      <label className="player-episodes-season" htmlFor={seasonId}>
        <span className="player-sr-only">选择季</span>
        <select id={seasonId} value={selectedKey} onChange={(event) => setSelectedSeasonKey(event.currentTarget.value)}>
          {seasons.map((season) => <option key={seasonKey(season.season)} value={seasonKey(season.season)}>{seasonLabel(season.season)}</option>)}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </label>
      <span className="player-episodes-count">可播放 {playableCount} 项</span>
    </div>}

    {props.loading ? <div className="player-episodes-state" role="status">
      <LoaderCircle className="player-episodes-spinner" size={28} aria-hidden="true" />
      <p>正在读取选集…</p>
    </div> : props.error ? <div className="player-episodes-state" role="alert">
      <ListVideo size={28} aria-hidden="true" />
      <p>暂时无法读取选集</p>
      <span>{props.error}</span>
      <button className="player-episodes-retry" type="button" onClick={props.onRetry}><RefreshCw size={15} aria-hidden="true" />重新加载</button>
    </div> : !selectedSeason?.items.length ? <div className="player-episodes-state" role="status">
      <ListVideo size={28} aria-hidden="true" />
      <p>暂无可选剧集</p>
      <span>媒体文件就绪后会显示在这里</span>
    </div> : <ul className="player-episodes-list" aria-label={`${seasonLabel(selectedSeason.season)}选集`}>
      {selectedSeason.items.map((item) => {
        const current = item.media_id === props.mediaId;
        const playable = Boolean(item.media_id && !item.rename_pending);
        const label = episodeLabel(item);
        return <li className="player-episode-row" key={item.media_id ?? item.path}>
          <button
            ref={current ? currentItemRef : undefined}
            className={`player-episode-item${current ? " is-current" : ""}`}
            type="button"
            disabled={!playable}
            aria-current={current ? "true" : undefined}
            title={item.filename}
            onClick={() => { if (item.media_id && playable) props.onSelect(item.media_id); }}
          >
            <EpisodeArtwork item={item} artwork={props.artwork} current={current} />
            <span className="player-episode-copy">
              <strong className="player-episode-title">{label}</strong>
              <span className="player-episode-filename">{item.filename}</span>
              <span className="player-episode-status">{item.rename_pending ? "正在整理文件…" : !playable ? "暂不可播放" : current ? "当前播放" : item.progress?.completed ? "已看完" : item.progress && item.progress.position > 0 ? "继续观看" : "立即播放"}</span>
            </span>
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}
