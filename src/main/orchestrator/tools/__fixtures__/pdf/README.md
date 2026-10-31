# PDF 回归字体夹具

这两个小字体由本目录 `generate.py` 独立生成，仅包含矩形轮廓和测试所需 Unicode 映射；未复制或重新分发任何系统/微软字体。它们随仓库采用相同许可证。

- `standalone.ttf`：独立 TTF，验证原有单字体分支。
- `collection.ttc`：含两个合成 face，PostScript 名刻意设为 `MicrosoftYaHei` / `SimSun`，仅验证 Windows 候选传递的 face 名称能选择 TTC 成员。不是这些商业字体，也不用于视觉质量验证。
- 再生成：安装 Python `fonttools` 后运行 `python generate.py`（仅维护夹具使用，常规测试不需要 Python 或系统字体）。

测试使用真实 PDFKit / Fontkit 解析字体并生成完整 PDF，检查嵌入 Unicode 映射。真实系统字体的渲染兼容性仍须另外测试，不能由合成字形证明。
