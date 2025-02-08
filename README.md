### 提取vue项目中文的简单小工具🔧

```sh
# 安装
npm i -g extract-zh-vue

# 提取
ez file_path -o file_path

# 白名单
ez -i xxx xxx ...
ez -r # 重置白名单
```

#### 使用建议

提取出来中文文件后，可以使用 [languine](https://languine.ai/en) 结合本地大模型进行机器翻译。

#### 注意

本工具覆盖了绝大部分的场景，但仍有一些场景无法覆盖，（可以用白名单来过滤一部分不想或不好提取的文本），建议一个文件一个文件的修改，小心点噢～。

欢迎提 issue & pr。