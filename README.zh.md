# Kitty Screen

[English README](README.md) · [GitHub](https://github.com/elliothux/kitty-screen) · [下载](https://github.com/elliothux/kitty-screen/releases)

Kitty Screen 是一个 Tauri + React 屏幕保护程序，会用猫咪动画作为屏幕遮挡层。它会在屏幕连续开启达到你设置的时间后自动启用，用来打断长时间不间断看屏幕的状态。

动画素材先通过绿幕猫咪视频生成，再用 FFmpeg 转成分平台的透明视频资源，供应用使用。

<p align="center">
  <img src="assets/icon.png" alt="Kitty Screen 应用图标" width="200" />
</p>

## 预览

<p>
  <img src="assets/preview-0.png" alt="Kitty Screen 遮挡效果预览 1" width="380" />
  <img src="assets/preview-1.png" alt="Kitty Screen 遮挡效果预览 2" width="380" />
</p>

## 下载

从 [GitHub Releases](https://github.com/elliothux/kitty-screen/releases) 下载最新应用构建。

## Prompt 模板

图片和视频生成用的可复用 prompt 放在 [PROMPTS.md](PROMPTS.md)。

后续生成新的猫咪形象，或者重新生成屏保动画序列时，优先参考这个文件。

## 如何定制我自己的猫咪形象

你可以把默认猫咪换成自己的猫。整体流程是先重新生成绿幕动画素材，再把绿幕视频转换成应用可直接加载的透明视频资源。

简化后的流程是：

1. 准备目标猫咪的参考照片。
2. 生成一组有顺序的绿幕关键帧。
3. 把关键帧生成完整入场视频和短循环视频。
4. 转换成 macOS 和 Windows 使用的透明资源。
5. 在应用里预览，根据效果微调绿幕抠像参数。

### 1. 准备猫咪参考照片

先收集清晰、高分辨率的猫咪照片。图片模型需要足够多的视觉信息，才能在每一帧里稳定保持同一只猫的身份。

建议准备这些照片：

- 正脸高清近照。
- 左右侧脸。
- 全身站立或行走姿态。
- 坐姿。
- 躺姿或放松姿态。
- 能看清毛色、花纹、爪子、尾巴、眼睛、耳朵形状和毛发长度的细节图。

参考图里尽量只出现一只猫。避免使用有其他动物、复杂背景、重滤镜、服装或极端光照的照片。如果你的猫有明显花纹，至少准备一张能清楚看到这些花纹的图。

### 2. 生成绿幕关键帧

使用 GPT Image 或其他支持参考图的图片模型，生成一组按编号排列的关键帧。目标是让你的猫按照项目内置示例的动作走位，同时保持自己的外观。

这里需要两类参考：

- 形象参考：你的猫咪照片，用来控制脸型、毛色、花纹、体型、毛长、爪子、尾巴和整体形象。
- 动作参考：`assets/raw-furryball/001.png` 到 `assets/raw-furryball/012.png`，用来控制姿态、镜头角度、身体位置和动画节奏。

建议把生成结果保存到新的目录：

```text
assets/raw-<cat-name>/001.png
assets/raw-<cat-name>/002.png
...
assets/raw-<cat-name>/012.png
```

每张图都应该使用纯 `#00ff00` 绿幕背景。保持背景干净，不要地面、阴影、渐变、道具、文字、UI、家具、房间背景或其他动物。背景越纯，后续 FFmpeg 抠像越稳定。

可以直接从 [PROMPTS.md](PROMPTS.md) 里的 prompt 开始改。替换猫咪形象描述时要写清楚你的猫的特征，但动作、构图和绿幕约束尽量保持严格。

### 3. 生成入场视频和循环视频

使用支持首帧、尾帧或有序关键帧控制的视频生成工具。把关键帧按编号顺序上传，生成一段连续的绿幕猫咪动画。

建议视频设置：

- 16:9 输出。
- 镜头固定。
- 全程保持同一只猫的形象。
- 全程保持均匀的 `#00ff00` 绿幕背景。
- 动作节奏是缓慢入画、停下、趴低，最后稳定挡住屏幕。
- 不要镜头缩放、平移、俯仰、跟随、房间背景、道具、文字、UI、阴影或第二只动物。

最终导出两段视频：

```text
assets/kitty.mp4
assets/kitty-loop.mp4
```

`assets/kitty.mp4` 是完整入场动画，应该包含猫咪进入画面、移动到目标位置并稳定挡住屏幕的过程。

`assets/kitty-loop.mp4` 是较短的待机循环片段，应该从稳定姿态开始，只保留轻微动作，比如呼吸、眨眼或小幅尾巴动作。这样屏保持续显示时不会一直重复完整入场动画。

### 4. 转换成应用资源

如果还没有安装依赖，先运行：

```bash
bun install
```

然后生成透明视频资源：

```bash
bun run videos
```

这个命令会运行 [scripts/generate-videos.mjs](scripts/generate-videos.mjs)。它会读取 `assets/kitty.mp4` 和 `assets/kitty-loop.mp4`，用 FFmpeg 去掉绿色背景、做绿色溢色处理、检查 alpha 通道，并输出分平台资源：

```text
resources/videos/macos/kitty-screen.mov
resources/videos/windows/kitty-screen.webm
```

如果你只在调某个平台，可以只生成单个平台：

```bash
bun run videos -- --platform macos
bun run videos -- --platform windows
```

### 5. 预览和调参

本地运行 Tauri 应用：

```bash
bun run app:dev
```

在应用里点击 Preview 预览遮挡效果。重点检查这些问题：

- 毛边是否残留绿色。
- 应该透明的区域是否没有透明。
- 背景是否闪烁。
- 猫咪形象是否在不同帧之间漂移。
- 循环片段重复时是否跳变明显。

如果绿幕抠像不干净，调整 [scripts/generate-videos.mjs](scripts/generate-videos.mjs) 里的 `keyColor`、`similarity`、`blend` 和 despill 相关常量，然后重新运行 `bun run videos`。如果问题是猫咪形象漂移、动作变化太大或循环衔接不自然，优先重新生成关键帧或视频；FFmpeg 参数只能处理抠像，不能修复源视频本身的不一致。

## 开发

安装依赖：

```bash
bun install
```

运行 Web 应用：

```bash
bun run dev
```

运行 Tauri 应用：

```bash
bun run app:dev
```

构建：

```bash
bun run build
```
