# 登录背景动漫海报

32 张日本动画海报，按用户指定的作品、季度和剧场版筛选。全部图片由 TMDB 图片服务下载，通过 ImageMagick 转为 480 × 720、2:3 比例、质量 80 的 WebP，适合登录页背景网格。

- `manifest.json`：作品名、TMDB ID、来源页面、下载地址、原图地址、抓取时间和文件大小。
- `*.webp`：前端可直接使用的本地图片，不依赖登录状态或运行时 TMDB 请求。
- `frontend/src/lib/login-posters.ts`：带作品资料的 `loginPosters`、当前组件使用的 `loginPosterItems` 和旧版组件使用的 `loginPosterUrls`。
- `docs/design/login-posters-preview.webp`：32 张海报的编号总览，已有编号保持不变，新作品从 41 起顺延，与清单的 `previewNumber` 对应，方便继续筛选。

本次指定作品与版本：

| 编号 | 作品与版本 |
| --- | --- |
| 25 | 刀剑神域：序列之争（替换 TV 版） |
| 33 | Code Geass 复活的鲁路修（此前反叛版已移除，恢复该编号） |
| 41 | 机动战士高达UC／独角兽（2010 年 OVA） |
| 42 | 闪光的哈萨维 第二部：喀耳刻的魔女 |
| 43 | 机动战士高达 GQuuuuuuX（TV 版） |
| 44 | 我独自升级 第二季 -从暗影中崛起- |
| 45 | 斩服少女 |
| 46 | 电锯人剧场版：蕾塞篇 |
| 47 | 咔嗒咔嗒／GACHIAKUTA |
| 48 | 【我推的孩子】（动画版） |
| 49 | 恶魔人 哭泣之子 |
| 50 | 狂赌之渊××（第二季专属海报） |

保留 20 号《我独自升级》原海报，44 号另用第二季专属主视觉。TMDB 目前将两季共 25 集合并在 `/tv/127532` 的第 1 季；脚本通过 `POSTER_OVERRIDES` 固定已核对的第二季图片，避免取成第一季或总集篇。

## 接入 Grid Motion

项目已在 `frontend/src/components/auth-screen.tsx` 接入 [React Bits Grid Motion](https://reactbits.dev/backgrounds/grid-motion)。组件源码及许可证位于 `frontend/src/components/grid-motion.*`，并调整了每行序列长度，保证全部海报都参与滚动。下面是独立使用的最小示例：

登录页采用 6 行海报网格，以缩小单张海报并增加同屏展示数量。表单使用 [Magic UI Magic Card](https://magicui.design/docs/components/magic-card)，仅保留靠右的登录卡片，组件与许可证位于 `frontend/src/components/ui/magic-card.*`。

```tsx
import GridMotion from "@/components/grid-motion"
import { loginPosterItems } from "@/lib/login-posters"

export function LoginBackground() {
  return (
    <div className="fixed inset-0" aria-hidden="true">
      <GridMotion items={loginPosterItems} rows={6} gap={12} aspectRatio={2 / 3} />
      <div className="pointer-events-none absolute inset-0 bg-black/55" />
    </div>
  )
}
```

当前[官方 TypeScript 源码](https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/GridMotion/GridMotion.tsx) 支持 `{ src, alt }`，行列数量随容器大小计算，图片不足时循环使用。设置 `aspectRatio={2 / 3}` 可以保持竖版海报比例。旧版组件若只接受 URL 字符串，传入 `loginPosterUrls`；若其网格写死为 4 × 7，则默认只展示前 28 张，需调整网格才能展示更多。

## 重新下载

在项目根目录使用已安装后端依赖的 Python 运行：

```powershell
& .\backend\.venv\Scripts\python.exe .\scripts\fetch_login_posters.py
```

需要本机后端已配置 TMDB 读访问令牌或 API 密钥，并且 `magick` 在 PATH 中。脚本只读现有配置，不会把凭据写入素材或清单；默认复用清单中匹配的已有素材，仅下载新增或替换项。添加 `--refresh` 可重新下载全部海报。作品列表同时包含 TV 与电影，重新运行不会恢复已移除的 TV 版海报。

## 来源署名

图片来自 [TMDB](https://www.themoviedb.org)，图片权利归原权利人所有。按 [TMDB 署名要求](https://developer.themoviedb.org/docs/faq)，应用的 About / Credits 区域需使用官方认可的 TMDB 标志，并包含以下声明：

> This product uses the TMDB API but is not endorsed or certified by TMDB.

当前目录提供素材和出处记录；正式接入页面时按上述要求补齐应用署名。
