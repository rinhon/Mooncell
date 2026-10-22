import manifest from "../../public/artwork/anime-posters/manifest.json"

/** 登录背景使用本地素材，适配 Vite 的 base 配置。 */
export const loginPosters = manifest.posters.map((poster) => ({
  ...poster,
  src: `${import.meta.env.BASE_URL}artwork/anime-posters/${poster.filename}`,
}))

/** 可直接传给当前 React Bits GridMotion 的 items 属性。 */
export const loginPosterItems = loginPosters.map(({ src, title }) => ({ src, alt: title }))

/** 兼容仅接受 URL 字符串数组的旧版 GridMotion。 */
export const loginPosterUrls = loginPosters.map(({ src }) => src)
