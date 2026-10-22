# 前端全局特效与交互约定

[返回 README](../README.md) · [开发指南](DEVELOPMENT.md)

本文记录当前源码中的视觉效果、生效范围和调整入口。修改共享组件时同步更新本文；此前的审美优化记录保留为历史记录。

## 生效范围

- **全局样式**：通过 `frontend\src\index.css` 引入，包含主题变量、焦点提示、滚动条及减少动态效果规则。
- **主界面框架**：登录后的主界面共用背景、导航和页面进入动画；`/watch/` 播放页面绕过该框架，登录界面使用独立布局。
- **共享组件默认效果**：使用对应组件时生效，例如 `Button`、`DialogContent`、`Card`，不会自动覆盖所有原生 HTML 元素。
- **局部启用效果**：必须引入组件或传入参数才生效，例如 `BlurFade`、图标旋转、菜单高度动画和反光按钮。

## 全局与主界面框架

| 效果 | 当前行为 | 实现与调整入口 |
| --- | --- | --- |
| 动态颗粒渐变背景（Grainient） | 主界面背景缓慢流动，颜色随主题变化；当前 `timeSpeed={0.3}`。组件离开视口、标签页进入后台或启用减少动态效果时停止逐帧渲染 | [app.tsx](../frontend/src/app.tsx)、[grainient.tsx](../frontend/src/components/grainient.tsx)；静态背景可将速度设为 `0`，若需停止渲染循环则调整组件挂载或其循环控制 |
| 页面进入动画（Page Enter） | 路径变化后内容从透明、向下偏移 8px 的状态淡入回到原位，使用弹簧缓动；番剧详情页跳过框架的进入动画，由详情页处理自身动画 | [app-shell.tsx](../frontend/src/components/app-shell.tsx) 的 `.page-content` |
| 导航鼠标跟随光晕（Pointer Glow） | 顶栏光晕跟随指针移动，仅在支持精细指针悬停且未启用减少动态效果时显示 | [app-shell.tsx](../frontend/src/components/app-shell.tsx)、[shell.css](../frontend/src/styles/shell.css) 的 `.navigation-glow` |
| 导航高亮滑动（Sliding Indicator） | 悬停背景在导航项之间移动，主导航选中项底部有滑动下划线，位置和宽度使用弹簧动画 | 同上，`NavigationIndicator`、`.navigation-hover`、`.rail-slider` |
| 品牌文字描边（Stroke Text） | 顶栏 MOONCELL 文字首次挂载及悬停时播放描边、填充动画 | [app-shell.tsx](../frontend/src/components/app-shell.tsx)、[stroke-text.tsx](../frontend/src/components/stroke-text.tsx)；当前 `trigger="hover"` 并开启 `playOnMount` |
| 顶栏毛玻璃（Backdrop Blur） | 顶栏使用主题半透明背景与 18px 背景模糊；属于静态视觉样式 | [shell.css](../frontend/src/styles/shell.css) 的 `.top-navigation` |
| 键盘焦点提示（Focus Visible） | 按钮、链接、输入框等使用主题强调色轮廓；部分组件提供自己的边框或光圈样式 | [index.css](../frontend/src/index.css) 的 `:focus-visible` 与各共享组件；调整装饰动效时保留可辨识的焦点反馈 |
| 滚动条与文本选中 | 统一滚动条宽度、主题配色及悬停颜色；文本选中使用强调色背景和对应前景色 | [index.css](../frontend/src/index.css) 的滚动条规则与 `::selection` |

## 共享按钮

实现入口：[button.tsx](../frontend/src/components/ui/button.tsx)、[button.css](../frontend/src/components/ui/button.css)。

### 背景扫入仅用于主按钮

从左向右的背景扫入称为 **Hover Fill / Left-to-right Fill**。填充层以左侧为原点，将 `scaleX` 从 `0` 动画到 `1`，移开后收回；鼠标悬停和键盘聚焦均可触发。

| `variant` | 用途 | 悬停／键盘聚焦效果 |
| --- | --- | --- |
| `default`（默认值） | 主按钮 | 保留从左向右的背景扫入，使用 `--accent-hover`，弹簧参数为 `stiffness: 500`、`damping: 40` |
| `outline` | 描边按钮 | 直接切换为强调色背景和对应前景色，无扫入动画 |
| `secondary` | 次要按钮 | 直接切换为抬升表面色背景，文字变亮，无扫入动画 |
| `ghost` | 幽灵／无背景按钮，例如“改名” | 直接切换为抬升表面色背景，文字变亮，无扫入动画 |
| `danger` | 危险操作按钮 | 直接切换为危险色混合背景，无扫入动画 |

共享组件只为 `variant="default"` 渲染 `.ui-button-fill`。新增普通操作时明确选择合适变体，避免省略 `variant` 后意外成为带扫入效果的主按钮。禁用或加载中的按钮不触发扫入。

### 其他按钮效果

| 效果 | 默认行为 | 控制方式 |
| --- | --- | --- |
| 按压缩放（Press Scale） | 普通 `Button` 按下缩至 `0.97`，松开回弹；禁用、加载中或减少动态效果时不缩放 | 普通 `Button` 使用 `pressMotion={false}` 关闭 |
| 子元素模式按压 | `Button asChild` 使用 CSS `:active` 缩至 `0.98` | 当前不受 `pressMotion` 控制，由 `.ui-button[data-as-child]:not(:disabled):active` 控制；减少动态效果时关闭 |
| 图标旋转（Icon Rotation） | 默认不旋转 | 通过 `icon` 属性提供图标，并设置 `iconMotion="rotate"`（90°）或 `iconMotion="refresh"`（180°）；仅精细鼠标悬停触发 |
| 加载图标（Loading Spinner） | `pending` 状态显示旋转加载图标，禁用操作，可替换标签文字 | `pending`、`pendingLabel`；旋转使用 `motion-safe:animate-spin` |

`NativeButton` 只包装原生按钮及文字，不自动附带共享 `Button` 的扫入、按压缩放和图标旋转。直接放在 `children` 中的图标也不会自动获得 `iconMotion`。

```tsx
<Button>保存</Button>
<Button variant="ghost" icon={Pencil}>改名</Button>
<Button variant="secondary" pressMotion={false}>取消</Button>
<Button variant="secondary" icon={RefreshCw} iconMotion="refresh">刷新</Button>
```

## 其他共享组件

| 组件／效果 | 默认行为与生效条件 | 实现与调整入口 |
| --- | --- | --- |
| 卡片毛玻璃 | `Card` 默认使用主题半透明背景、边框和 8px 背景模糊；不会为所有卡片自动添加光晕或悬停缩放 | [card.tsx](../frontend/src/components/ui/card.tsx) |
| 弹窗淡入与缩放 | `DialogContent` 默认遮罩淡入，内容从 `0.98` 缩放至 `1`；关闭时淡出并轻微缩小 | [dialog.tsx](../frontend/src/components/ui/dialog.tsx) |
| 弹窗自适应高度 | `animateSize` 默认关闭；开启后加入高度弹簧过渡及轻微纵向位移 | 同上；按需使用 `<DialogContent animateSize>` |
| 下拉菜单展开 | `DropdownMenuContent` 的 `animateSize` 默认关闭；开启后高度从 `0` 展开至内容高度并淡入，关闭时收起 | [dropdown-menu.tsx](../frontend/src/components/ui/dropdown-menu.tsx) |
| 选择框与提示气泡弹出 | `SelectContent`、延迟出现的 `TooltipContent` 使用 150ms 的淡入和 4px 位移；共享提示气泡等待时间为 350ms | [index.css](../frontend/src/index.css)、[select.tsx](../frontend/src/components/ui/select.tsx)、[tooltip.tsx](../frontend/src/components/ui/tooltip.tsx)、[main.tsx](../frontend/src/main.tsx) |
| 输入焦点与菜单项高亮 | `Input` 聚焦时边框变为强调色；选择框增加焦点光圈；菜单候选项高亮时变色 | [input.tsx](../frontend/src/components/ui/input.tsx)、[select.tsx](../frontend/src/components/ui/select.tsx)、[dropdown-menu.tsx](../frontend/src/components/ui/dropdown-menu.tsx) |
| 模糊渐入（Blur Fade） | 显式使用 `BlurFade` 时生效；默认时长 0.4s、位移 6px、模糊 6px，可调整方向、延迟和参数；`inView` 开启后首次进入视口才播放 | [blur-fade.tsx](../frontend/src/components/ui/blur-fade.tsx)；首页、番剧、订阅和集数列表已有使用，错峰延迟由各调用处设置 |
| 图片加载渐显（Image Fade In） | `FadeInImage` 的图片就绪后以 420ms 透明度过渡显示，缓存图片可直接进入就绪状态 | [fade-in-image.tsx](../frontend/src/components/ui/fade-in-image.tsx)、[fade-in-image.css](../frontend/src/components/ui/fade-in-image.css)；仅显式使用该组件的图片生效 |
| 进度条平滑变化 | `Progress` 的进度指示器使用 500ms 位移过渡 | [progress.tsx](../frontend/src/components/ui/progress.tsx) |
| Toast 滑入与滑动关闭 | 全局提示使用 `SwipeToast` 从底部滑入，带倒计时条，支持拖动关闭；当前统一持续时间为 3600ms | [toast.tsx](../frontend/src/components/ui/toast.tsx)、[swipe-toast.tsx](../frontend/src/components/swipe-toast.tsx)、[swipe-toast.css](../frontend/src/components/swipe-toast.css) |
| 骨架占位 | `Skeleton` 本身只提供主题底色与圆角，未内置脉冲、扫光动画 | [skeleton.tsx](../frontend/src/components/ui/skeleton.tsx)；调用处可另外设置动画 |

## 局部特效边界

以下效果在指定场景启用，维护共享样式时不要把它们误当成所有同类控件的默认行为。

| 效果 | 当前使用位置 | 实现入口 |
| --- | --- | --- |
| 反光按钮（Specular Button） | 番剧详情标题旁的“作品操作”按钮，带反光、鼠标跟随效果 | [specular-button.tsx](../frontend/src/components/ui/specular-button.tsx)、[show-detail.tsx](../frontend/src/pages/show-detail.tsx) |
| 卡片鼠标光晕（Magic Card） | 登录界面的表单面板 | [magic-card.tsx](../frontend/src/components/ui/magic-card.tsx)、[auth-screen.tsx](../frontend/src/components/auth-screen.tsx) |
| 缩略图播放叠加按钮（Play Overlay） | 本地集数缩略图中央的圆形播放图标，悬停或聚焦时高亮、轻微放大 | [show-episode-list.tsx](../frontend/src/components/show-episode-list.tsx)、[show-detail.css](../frontend/src/pages/show-detail.css) |
| 图片上传反馈 | 上传弹窗的预览区可点击选图，悬停或键盘聚焦时边框高亮，已有图片上显示上传图标与选图提示；触屏常显提示，上传中禁用；原生文件选择按钮也有变色反馈 | [artwork-upload.tsx](../frontend/src/components/artwork-upload.tsx)、[artwork-upload.css](../frontend/src/components/artwork-upload.css) |
| 海报、列表行及页内切换动效 | 番剧海报、日历、首页画廊、详情页标签等各自定义 | 对应页面和组件文件；不由共享 `Button` 或 `Card` 统一注入 |

## 减少动态效果与维护

项目跟随系统／浏览器的 `prefers-reduced-motion`，当前没有单独的应用内“关闭所有特效”开关。

- [main.tsx](../frontend/src/main.tsx) 使用 `<MotionConfig reducedMotion="user">`，Motion 组件还在需要时通过 `useReducedMotion()` 调整行为。
- [index.css](../frontend/src/index.css) 将 CSS 动画与过渡时间缩短至 `.01ms`，限制动画次数，并关闭平滑滚动；部分组件另有专门的减少动态效果规则。
- 动态背景暂停渲染循环；导航光晕隐藏；按钮扫入变为即时状态变化，按压缩放和图标悬停旋转关闭；`BlurFade` 直接显示内容，图片渐显取消过渡。
- 减少动态效果不等于移除全部视觉样式：毛玻璃、主题颜色、焦点提示仍保留，部分透明度变化也可能继续存在。新增 JavaScript、Canvas 或 WebGL 动画时需单独处理该偏好，不能只依赖 CSS 覆盖。

修改效果后检查主按钮与普通按钮、鼠标悬停与键盘聚焦、禁用与加载状态、触屏及减少动态效果分支。新增特效应明确默认值、生效范围和调整入口，并同步更新本清单。
