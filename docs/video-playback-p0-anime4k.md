# Anime4K P0 验证记录

日期：2026-10-20。状态：适配实现、静态类型检查和模拟生命周期测试完成；Windows Chrome 已完成真实 GPU 与 30 分钟播放观察。其他浏览器和真实局域网 HTTPS 仍待验收。

## 依赖与选型

官方 npm 注册表当前 `anime4k-webgpu` 的 latest 为 **1.0.0**，本项目精确锁定该版本；包内包含 `lib/index.d.ts`，声明 `@webgpu/types ^0.1.38` 为 peerDependency。项目精确锁定 `@webgpu/types 0.1.74` 开发依赖，并在适配文件内显式引用，避免依赖全局隐式类型装载。

包元数据及上游 `LICENSE.md` 均声明 MIT；使用 npm 原始包，未复制修改其模型、权重或着色器。MIT 许可证随包分发保留。上游 `render()` 只返回 `Promise<void>`，内部无限递归登记视频帧回调，没有取消或销毁 API，因此不使用该高层封装。

本项目使用其公开底层接口：`new CNNx2M({ device, inputTexture })`（轻量）、`new CNNx2VL(...)`（标准）；`pass(commandEncoder)` 写入当前帧计算命令，`getOutputTexture()` 提供 2 倍输出纹理。轻量/标准为 Mooncell 的档位命名，并非上游性能承诺。当前机器已确认可见增强，其他硬件的质量与性能门槛仍需实测。

来源：

- [官方 npm 元数据](https://registry.npmjs.org/anime4k-webgpu/latest)
- [WebGPU 类型 npm 元数据](https://registry.npmjs.org/@webgpu%2Ftypes/latest)
- [上游说明与低层 pipeline 用法](https://github.com/Anime4KWebBoost/Anime4K-WebGPU)
- [上游渲染器源码](https://github.com/Anime4KWebBoost/Anime4K-WebGPU/blob/main/src/renderer/index.ts)
- [CNNx2M 源码](https://github.com/Anime4KWebBoost/Anime4K-WebGPU/blob/main/src/pipelines/upscale/CNNx2M/index.ts)
- [CNNx2VL 源码](https://github.com/Anime4KWebBoost/Anime4K-WebGPU/blob/main/src/pipelines/upscale/CNNx2VL/index.ts)
- [上游许可证](https://github.com/Anime4KWebBoost/Anime4K-WebGPU/blob/main/LICENSE.md)

## 适配原型

入口为 `frontend\src\lib\player\anime4k-renderer.ts` 的 `createAnime4kRenderer({ video, canvas, container, ... })`。返回 `setMode('off' | 'light' | 'standard')`、`renderCurrentFrame()`、`getState()`、幂等 `destroy()`；状态回调报告用户请求档位、实际生效档位、初始化/就绪/不可用/失败状态和中文原因。

- 使用播放器原有 video 作为唯一画面输入，不创建第二个媒体元素，也不写入 `currentTime`、`playbackRate` 或控制音频、播放状态。
- 检查安全上下文、WebGPU、视频帧回调、adapter、device、Canvas 上下文及 GPU 纹理尺寸。失败保持普通 video 可用。
- 各实例独占 GPUDevice；关闭、切换档位、源尺寸变化及卸载时取消视频帧回调/动画回调，取消监听器/观察器，并销毁输入纹理和整个 device。该设计通过公开 `device.destroy()` 释放上游未暴露销毁 API 的内部纹理/缓冲。
- 异步初始化各等待点检查实例代次。设备创建晚于卸载时立即销毁，不重新登记回调。
- `requestVideoFrameCallback` 随媒体帧调度；每次最多一个 GPU 提交在途，避免处理慢时无限积压。暂停/seeked/resize 会主动重新绘制当前静帧；后台标签页停止调度。
- 输出随容器、窗口、全屏和 DPR 变化，保持源宽高比。默认 DPR 上限 1.5，Canvas 及模型 x2 中间输出分别有 3840 × 2160 像素上限；更大源输入回退普通播放。模型仍先按源尺寸计算再向 Canvas 采样，缩小窗口不会改变其卷积成本。
- GPU device 丢失时尝试重建一次，再次丢失恢复普通播放。性能连续 24 帧超过所估帧预算的 115% 时标准降轻量，轻量仍慢则关闭；每次用户手动选择后的自动降级链最多提示一次，不自动升档。
- 帧预算由视频媒体帧时间、帧计数与播放倍速估算。指标为 **提交到队列完成的墙钟延迟**，包含驱动、调度与呈现开销，不能称为 GPU timestamp 耗时。

## 已执行验证

Windows 本机 Node 通过以下检查：

```powershell
& 'C:\Program Files\nodejs\node.exe' node_modules\typescript\bin\tsc -p tests\tsconfig.player.json --pretty false
& 'C:\Program Files\nodejs\node.exe' --test tests\anime4k-renderer.test.cjs tests\webvtt.test.cjs
```

适配层 strict TypeScript 独立检查通过。模拟设备测试覆盖：安全上下文回退、异步设备晚到后的销毁、暂停 seek 静帧、像素限制、重复换档与幂等销毁、源尺寸重建、device lost 一次恢复后回退、持续慢帧标准→轻量→关闭及单次提示。字幕解析另测时间戳、多行、标签剥离、NOTE/STYLE 跳过和无效响应拒绝。

## 已执行的真实 Chrome 验证

以下由本次任务 root 在 Windows Chrome 实机记录，显卡为 **RTX 4070 SUPER**。此处属于真实浏览器结果，区别于前述模拟设备测试。

- 23.976 fps 片源在 720p、1080p 输出下，轻量与标准增强均实际可见；观察到 Canvas 尺寸为 **1422 × 800**。
- 暂停静态画面、切换至 720p、全屏切换已验证；开启增强后源时间轴保持连续。
- 720p、标准档、**0.5 倍速**时，抽样的提交至队列完成延迟为 **4.9 ms / 9.2 ms**，对应估计帧预算 **83.42 ms**。这是两个现场抽样值，未构成均值、分位数或持续性能保证，也不是 GPU timestamp 查询结果。

## 持续播放观察

本次生产构建已在 Windows Chrome 完成 30 分钟播放与后端/缓存资源采样；期间实际切换标准、轻量、关闭和重新开启标准，播放时钟保持 1 倍速，终点后仍正常播放。24 fps、720p 的标准模式现场采样约 4.2–6.1 ms，低于约 41.67 ms 的估计帧预算。全机显存尾段采样未持续增长，但没有把全局显存归因于单个 GPUDevice，也没有测得独占 Chrome 标签页 RSS。详细范围与结果见[交付验证](video-playback-validation.md)和[硬件采样](video-playback-hardware.md)。

## 尚待验收

真实 device lost 与性能降级、60 fps 和其他显卡门槛仍待验证。Edge、Firefox、Safari 与可信 HTTPS 局域网未验收；HTTP 非安全上下文回退仍需真实网络专项验证。上述 Chrome 结果不代表 P0/P4 全部兼容条件均已通过。
