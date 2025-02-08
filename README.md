### 提取vue项目中文的简单小工具🔧

```sh
# 安装
npm i -g extract-zh-vue

# 提取
ez file_path -o file_path
```

#### 使用建议

提取出来中文文件后，可以使用 [languine](https://languine.ai/en) 结合本地大模型进行机器翻译。

#### 注意

本工具覆盖了绝大部分的场景，但仍有一些场景无法覆盖，比如：

- 日期类格式化中文也会被提取到，需要手动还原处理。

如果你有想法，欢迎提 issue & pr。