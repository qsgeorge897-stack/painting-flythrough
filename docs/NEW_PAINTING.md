# 换一幅画：改哪些地方

以做北斋《神奈川冲浪里》为例，名字定为 `wave`。照着这份清单走，一般半天能出第一版。

## 1. 素材

```bash
python3 scripts/fetch_wikimedia.py "File:Tsunami by hokusai 19th century.jpg" wave --width 3840   # 标题以 Commons 上实际的为准
python3 scripts/depth.py wave
```

先看 `img/wave.jpg` 有没有白边，再看 `depth/wave_vis.png` 主体是否清楚、天空/背景是否平整。

## 2. `web/data/worlds.json` 加一条

复制 `starry` 改：

```json
"wave": { "fov": 62, "zn": 2.0, "zf": 40, "gamma": 1.2, "D": 1.8, "layers": 7, "edge": 0.3, "clear": "0x1c2a40", "flow": true }
```

- `flow: true` 表示这幅画有流向场和光源文件（没有就删掉这一项，引擎会用静态画面）。
- `clear` 设成画面里最远处的平均色，偶尔露出空隙时不扎眼。

## 3. 写 `scripts/paintings/wave.py`

复制 `scripts/paintings/starry_night.py`，按这幅画改：

| starry_night.py 里的段落 | 换成 wave 要做什么 |
|---|---|
| 1. 裁边 | 改裁切像素，或者整段删掉 |
| 2. 天际线 `HILL` + 柏树遮罩 | 改成这幅画的分界线：海天分界、巨浪、富士山、小船各是什么深度 |
| 3. 光源 `STARS` | 改成浪尖高光、远处的光点；没有光源就写空列表、去掉 `moon`（引擎会自动跳过） |
| 4. 流向场 | 参考流向改成浪的卷曲方向：大浪顺时针卷、泡沫往外甩、天空几乎不动 |
| 5. 前景背后的修补 | 浪的背后应该是天空或远海，改遮罩和"借色"的方向 |

每改一段都看一眼 `debug/` 里的输出图。

## 4. 镜头 `web/film.js`

1. 复制 `starryShot` 成 `waveShot`，把 `worlds.starry` 换成 `worlds.wave`。
2. 在文件末尾登记两处：`SHOTS` 里加 `wave: waveShot`，`NEEDS` 里加 `wave: { worlds: ['wave'] }`。
3. 按分镜改关键帧。先只改时间点和 HOME 的 `Y0`（构图中心），其他参数先沿用。

## 5. 预览 → 渲染 → 字幕 → 编码

```bash
node web/render.js --cut wave --out frames/wave_check --w 960 --h 540 --times 0.5,3,6,10,15,20,25,29
python3 scripts/contact_sheet.py frames/wave_check sheet.jpg
node web/render.js --cut wave --out frames/wave --range 0 30 --fps 30
python3 scripts/caption.py frames/wave frames/wave_cap --start 25 --end 29.5 --line1 "葛饰北斋 ｜《神奈川冲浪里》 约1831年 ｜ 木版画" --line2 "……（到馆藏官网核对）"
scripts/encode.sh frames/wave_cap out/wave.mp4
```

## 6. 做成一键流水线

复制 `pipelines/starry_night.sh` 为 `pipelines/wave.sh`，改掉画名、Commons 标题、时长和字幕。
