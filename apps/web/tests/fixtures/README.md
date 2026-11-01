preview.mp4 是本仓库自行生成的 64×64、1 秒灰色视频，仅用于浏览器媒体解码检查，无音轨及外部素材。

重建命令：

```sh
ffmpeg -f lavfi -i color=c=gray:s=64x64:d=1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y preview.mp4
```

PNG 在测试运行时使用浏览器 canvas 生成。
