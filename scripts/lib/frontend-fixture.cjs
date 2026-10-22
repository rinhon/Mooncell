/* Shared, deterministic browser fixtures. No live service or external image is needed. */
const path = require('node:path');

function loadPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_PATH, 'playwright', path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
    try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('未找到 Playwright；请设置 PLAYWRIGHT_PATH 为已安装的包路径。');
}

const titles = ['葬送的芙莉莲', '迷宫饭', '夏目友人帐', '紫罗兰永恒花园', '摇曳露营', '跃动青春', '孤独摇滚', '药屋少女的呢喃', '冰菓', '四叠半神话大系', '吹响吧！上低音号', '来自深渊'];
const stamp = '2026-10-22T08:00:00+08:00';
const parsed = name => ({ raw_title: `[Mooncell] ${name} - 03 [1080p][CHS].mkv`, title: name, release_group: 'Mooncell', media_type: 'tv', release_kind: 'single', season: 1, episode_start: 3, episode_end: 3, revision: 1, resolution: '1080p', sources: ['WEB'], subtitle_languages: ['zh-Hans'], video_codecs: ['HEVC'], audio_codecs: ['AAC'], container: 'mkv', confidence: .94, evidence: ['番剧标题与订阅匹配', '单集编号已识别'], warnings: [] });
const shows = Array.from({ length: 36 }, (_, i) => ({ id: i + 1, name: `${titles[i % titles.length]}${i >= 12 ? ` · 第 ${Math.floor(i / 12) + 1} 季` : ''}`, metadata_title: titles[i % titles.length], active: i % 8 !== 7, created_at: stamp, tmdb_id: 200000 + i, media_type: 'tv', overview: '在日常与冒险之间，伙伴们踏上新的旅程。这里保留足够的中文简介，以验证真实卡片内容、换行与独立操作按钮。', release_date: '2026-10-01', episode_count: 12, rating: 7.5 + (i % 20) / 10, poster_url: `/__visual__/poster/${i + 1}.svg`, discovered_items: 12 + i, artwork_status: 'completed', poster_ready: true, fanart_ready: true, clearlogo_ready: false, artwork_version: 'fixture-v1' }));
const feeds = shows.slice(0, 8).map((show, i) => ({ id: show.id, name: show.name, url: `https://feeds.example.test/${show.id}.xml`, kind: 'standard', season: 1, active: true, excluded_keywords: ['繁體'], refresh_interval_minutes: 30, connection_status: i === 3 ? 'error' : 'healthy', last_checked_at: stamp, last_error: i === 3 ? '上游接口暂时不可用，将自动重试。' : null }));
const calendar = { season: '202610', current_season: '202610', source_url: 'https://example.test/calendar', fetched_at: stamp, items: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: shows[i % shows.length].name, weekday: i % 8 === 7 ? null : i % 8, broadcast_time: `${String(20 + i % 4).padStart(2, '0')}:30`, cover_url: `/__visual__/calendar/${i + 1}.svg`, liked: i % 5 === 0 })) };
const tasks = shows.slice(0, 6).map((show, i) => ({ id: show.id, source_id: show.id, title: `[Mooncell] ${show.name} - 03 [1080p][CHS].mkv`, source_name: show.name, download_url: `magnet:?xt=urn:btih:${String(i).padStart(40, '0')}`, published_at: stamp, discovered_at: stamp, matched: true, status: i === 5 ? 'completed' : 'downloading', qb_state: i === 5 ? 'uploading' : 'downloading', progress: i === 5 ? 100 : 21 + i * 12, download_speed: i === 5 ? 0 : 1024 * 1024 * (i + 1), upload_speed: 1024 * 24, eta: 60 * (i + 1), size: 1024 ** 3, downloaded: 1024 ** 3 * (i === 5 ? 1 : .21 + i * .12), automation_state: null }));
const notifications = [{ id: 'fixture-scrape', kind: 'feed_scrape', source_id: 1, source_name: shows[0].name, status: 'running', total_count: 12, completed_count: 8, summary: '正在同步本季发布信息', error_summary: null, created_at: stamp, updated_at: stamp, finished_at: null, revision: 1, attention_revision: 1, read_revision: 0, unread: true }];

function artwork(id, kind) {
  const wide = kind === 'fanart';
  const hue = (Number(id) * 37) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wide ? 960 : 400}" height="${wide ? 540 : 600}" viewBox="0 0 ${wide ? 960 : 400} ${wide ? 540 : 600}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue},38%,48%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},40%,12%)"/></linearGradient></defs><path fill="url(#g)" d="M0 0h960v600H0z"/><circle cx="${wide ? 700 : 300}" cy="150" r="85" fill="#fff" opacity=".22"/><path d="M0 430 130 240 245 390 350 220 580 540H0z" fill="#101b27" opacity=".55"/><path d="M0 510 180 340 360 490 540 300 960 540H0z" fill="#16252a" opacity=".7"/><text x="28" y="${wide ? 470 : 530}" font-family="sans-serif" font-size="26" fill="#fff">MOONCELL · ${String(id).padStart(2, '0')}</text><text x="28" y="${wide ? 505 : 565}" font-family="sans-serif" font-size="13" letter-spacing="4" fill="#fff">SEASON 2026 / VISUAL FIXTURE</text></svg>`;
}

async function installFixtures(target, options = {}) {
  const { theme = 'forest', auth = 'authenticated', imageDelayMs = 0, seed = 42 } = options;
  const requests = [], unmocked = [];
  await target.addInitScript(({ theme, seed }) => {
    try { localStorage.setItem('mooncell-theme', theme); } catch {}
    if (document.documentElement) document.documentElement.dataset.theme = theme;
    let random = seed;
    Math.random = () => ((random = Math.imul(1664525, random) + 1013904223 >>> 0) / 4294967296);
    const NativeDate = Date;
    window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-22T12:00:00+08:00'])); } static now() { return NativeDate.now(); } };
    window.EventSource = class extends EventTarget { close() {} };
  }, { theme, seed });
  await target.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const match = url.pathname.match(/\/shows\/(\d+)\/artwork\/(\w+)/) || url.pathname.match(/\/__visual__\/(\w+)\/(\d+)\.svg/);
    if (match || request.resourceType() === 'image') {
      if (imageDelayMs) await new Promise(resolve => setTimeout(resolve, imageDelayMs));
      const id = match ? (url.pathname.includes('/artwork/') ? match[1] : match[2]) : 1;
      const kind = match ? (url.pathname.includes('/artwork/') ? match[2] : match[1]) : 'poster';
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: artwork(id, kind) }).catch(() => {});
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) return route.fallback();
    const pathname = url.pathname.replace('/api/v1', '');
    requests.push(`${request.method()} ${pathname}`);
    let data;
    if (pathname === '/auth/status') data = { initialized: auth !== 'bootstrap', authenticated: auth === 'authenticated', username: auth === 'authenticated' ? 'visual-admin' : undefined };
    else if (pathname === '/shows') data = shows;
    else if (pathname === '/feeds') data = feeds;
    else if (/^\/shows\/\d+$/.test(pathname)) { const show = shows.find(item => item.id === Number(pathname.split('/')[2])) || shows[0]; data = { ...show, subscription: feeds.find(feed => feed.id === show.id) || { ...feeds[0], id: show.id, name: show.name }, genres: ['动画', '冒险'], vote_count: 1800, metadata_scraped_at: stamp }; }
    else if (/^\/shows\/\d+\/library$/.test(pathname)) data = { available: true, partial: false, total: 3, seasons: [{ season: 1, items: Array.from({ length: 3 }, (_, i) => ({ path: `F:\\Media\\Anime\\Season 01\\Episode ${i + 1}.mkv`, filename: `Episode ${i + 1}.mkv`, season: 1, episode_start: i + 1, episode_end: i + 1, size: 1024 ** 3, modified_at: stamp, added_at: stamp, media_id: `fixture-${i + 1}`, progress: i === 0 ? { position: 330, duration: 1440, completed: false } : null })) }] };
    else if (/^\/shows\/\d+\/items$/.test(pathname)) data = [parsed(shows[0].name).raw_title];
    else if (pathname === '/dashboard') data = { feeds: 8, healthy_feeds: 7, discovered_items: 196, needs_review: 2, downloaders: 1, healthy_downloaders: 1, recent_items: shows.slice(0, 5).map(show => ({ id: show.id, title: parsed(show.name).raw_title, status: 'matched', publishedAt: stamp, parsed: parsed(show.name) })) };
    else if (pathname === '/downloads') data = { downloader_configured: true, downloader_online: true, downloader_name: 'qBittorrent', downloader_version: '5.1.0', tasks, download_speed: 15 * 1024 ** 2, upload_speed: 144 * 1024 };
    else if (pathname === '/calendar') data = { ...calendar, season: url.searchParams.get('season') || calendar.season };
    else if (pathname === '/review') data = shows.slice(0, 2).map(show => ({ id: show.id, raw_title: parsed(show.name).raw_title, source_name: show.name, source_active: true, parsed: { ...parsed(show.name), confidence: .61 }, season: 1, reason: '检测到多个集数候选，请确认后继续。', proposed_path: `F:\\Media\\${show.name}\\Season 01\\S01E03.mkv`, job_state: null }));
    else if (pathname === '/logs') data = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, occurred_at: stamp, level: i === 3 ? 'warning' : 'info', scope: 'subscription', event_type: 'feed_refreshed', message: i === 3 ? '上游接口短暂失败，将自动重试。' : `${shows[i].name}：订阅同步完成，发现 2 条发布。`, source_id: i + 1, operation_id: null }));
    else if (pathname === '/downloaders') data = [{ id: 1, name: 'qBittorrent', kind: 'qbittorrent', base_url: 'http://127.0.0.1:8080', username: 'admin', active: true, connection_status: 'healthy' }];
    else if (pathname === '/notifications/summary') data = { unread_count: 1, active_count: 1 };
    else if (pathname === '/notifications') data = { unread_count: 1, active_count: 1, items: notifications, active_items: notifications, next_cursor: null, cutoff: stamp };
    else if (pathname === '/settings/library') data = { library_root: 'F:\\Media\\Anime', valid: true, exists: true, writable: true };
    else if (pathname === '/settings/library-scan') data = { running: false, finished_at: stamp, interval_seconds: 3600, scanned: 36, changed: 3, thumbnails: 3, errors: 0 };
    else if (pathname === '/settings/tmdb') data = { api_key_configured: true, read_access_token_configured: true };
    else if (pathname === '/settings/subscriptions') data = { proxy_url: null, refresh_interval_minutes: 30 };
    else if (pathname === '/setup/path-preview') data = { parsed: parsed(shows[0].name), directory: 'F:\\Media\\Anime\\葬送的芙莉莲\\Season 01', filename: '葬送的芙莉莲 - S01E03.mkv', full_path: 'F:\\Media\\Anime\\葬送的芙莉莲\\Season 01\\葬送的芙莉莲 - S01E03.mkv', library_root: 'F:\\Media\\Anime', folder_name: '葬送的芙莉莲', season_folder: 'Season 01', separator: '\\' };
    else { unmocked.push(`${request.method()} ${pathname}`); return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ detail: `视觉夹具未覆盖接口：${pathname}` }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return { requests, unmocked };
}

module.exports = { installFixtures, loadPlaywright, shows, feeds, calendar };
