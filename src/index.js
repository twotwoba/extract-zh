#!/usr/bin/env node

import { program } from "commander";
import { globSync } from "glob";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parse as babelParse } from "@babel/parser";
import traverse from "@babel/traverse";
import { parse as vueParse } from "@vue/compiler-sfc";
import { createHash } from "crypto";
import path from "path";

const translations = {};

// 将中文转换为哈希值，并生成语义化的key
function generateKey(text, filePath) {
  // 获取文件名（不含扩展名）
  const fileName = path.basename(filePath, path.extname(filePath));

  // 如果文件名为index，则使用父目录名作为前缀
  let prefix = fileName;
  if (fileName === "index") {
    const parentDir = path.basename(path.dirname(filePath));
    prefix = parentDir;
  }

  // 生成6位哈希值
  const hash = createHash("md5").update(text).digest("hex").slice(0, 6);

  return `${prefix}_${hash}`;
}

// 处理Vue文件
function processVueFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const { descriptor } = vueParse(content);
  let result = content;

  // 处理template部分
  if (descriptor.template) {
    const template = descriptor.template.content;
    let processedTemplate = template;

    // 处理所有HTML标签属性中的中文（不包括事件和动态绑定）
    const attributesRegex =
      /(\s)(?!:|@|v-)([\w-]+)=["']([^"']*[\u4e00-\u9fa5][^"']*)["']/g;
    processedTemplate = processedTemplate.replace(
      attributesRegex,
      (match, space, attr, text) => {
        // 检查是否在注释中
        const isInComment = /<!--[\s\S]*?-->/.test(match);
        if (!isInComment && !/\$t\(['"].*['"]\)/.test(text)) {
          const key = generateKey(text, filePath);
          translations[key] = text;
          return `${space}:${attr}="$t('${key}')"`;
        }
        return match;
      }
    );

    // 处理带模板字符串的属性
    const templateAttrRegex = /:(\w+)=["']`([^`]*\${[^}]+}[^`]*)`["']/g;
    processedTemplate = processedTemplate.replace(
      templateAttrRegex,
      (match, attr, text) => {
        if (!/[\u4e00-\u9fa5]/.test(text)) return match;

        // 提取模板表达式
        const expressions = [];
        const cleanText = text.replace(/\${([^}]+)}/g, (_, expr) => {
          expressions.push(expr.trim());
          return '{props}';
        });

        if (/[\u4e00-\u9fa5]/.test(cleanText)) {
          const key = generateKey(cleanText, filePath);
          translations[key] = cleanText;
          return `:${attr}="$t('${key}', { props: ${expressions[0]} })"`;
        }
        return match;
      }
    );

    // 处理事件处理器和属性中的对象字面量中的中文
    const eventHandlerRegex = /@[\w.-]+="([^"]+)"|:[\w.-]+="([^"]+)"/g;
    processedTemplate = processedTemplate.replace(
      eventHandlerRegex,
      (match, eventContent, bindContent) => {
        // 检查是否在注释中
        const isInComment = /<!--[\s\S]*?-->/.test(match);
        const content = eventContent || bindContent;
        if (isInComment || !content || !content.includes("'")) return match;

        // 处理对象字面量中的中文字符串
        const processedContent = content.replace(
          /(['"])([^'"]*[\u4e00-\u9fa5][^'"]*)\1/g,
          (_, quote, text) => {
            const key = generateKey(text, filePath);
            translations[key] = text;
            return `${text.includes("{") ? text : `$t('${key}')`}`;
          }
        );

        return match.replace(content, processedContent);
      }
    );

    // 处理三元表达式中的中文
    const ternaryRegex = /\{\{([^}]+)\}\}/g;
    processedTemplate = processedTemplate.replace(
      ternaryRegex,
      (match, expression) => {
        // 替换表达式中的中文字符串
        const processedExpression = expression
          .replace(/'([^']*[\u4e00-\u9fa5][^']*)'/g, (_, text) => {
            const key = generateKey(text, filePath);
            translations[key] = text;
            return `$t("${key}")`;
          })
          .replace(/"([^"]*[\u4e00-\u9fa5][^"]*)"/g, (_, text) => {
            const key = generateKey(text, filePath);
            translations[key] = text;
            return `$t("${key}")`;
          });

        return `{{ ${processedExpression} }}`;
      }
    );

    // 处理包含插值表达式的中文内容
    const interpolationRegex =
      />([^<>]*[\u4e00-\u9fa5][^<>]*\{\{[^}]+\}}[^<>]*[\u4e00-\u9fa5][^<>]*)</g;
    processedTemplate = processedTemplate.replace(
      interpolationRegex,
      (match, text) => {
        if (text.trim() && !/\$t\(['"].*['"]\)/.test(text)) {
          // 提取插值表达式
          const interpolationMatch = text.match(/\{\{([^}]+)\}\}/);
          if (interpolationMatch) {
            const expression = interpolationMatch[1].trim();
            // 构建新的文本模板，将插值表达式替换为占位符，并清理格式
            const template = text
              .replace(/\{\{[^}]+\}\}/, "{{ props }}")
              .replace(/\s+/g, " ") // 将多个空白字符替换为单个空格
              .trim(); // 去除首尾空白

            // 检查是否已存在相同的翻译模板
            let existingKey = null;
            for (const [key, value] of Object.entries(translations)) {
              if (value === template) {
                existingKey = key;
                break;
              }
            }

            const key = existingKey || generateKey(template, filePath);
            if (!existingKey) {
              translations[key] = template;
            }
            return `>{{ $t("${key}", { props: ${expression} }) }}<`;
          }
        }
        return match;
      }
    );

    // 最后一步处理 >中文< 模式的内容
    const betweenTagsRegex = />([^<>]*[\u4e00-\u9fa5][^<>]*)</g;
    processedTemplate = processedTemplate.replace(
      betweenTagsRegex,
      (match, text) => {
        if (text.trim() && !/\$t\(['"].*['"]\)/.test(text)) {
          const key = generateKey(text.trim(), filePath);
          translations[key] = text.trim();
          return `>{{ $t("${key}") }}<`;
        }
        return match;
      }
    );

    result = result.replace(descriptor.template.content, processedTemplate);
  }
  // 处理script部分
  if (descriptor.script || descriptor.scriptSetup) {
    const script = (descriptor.script || descriptor.scriptSetup).content;
    const ast = babelParse(script, {
      sourceType: "module",
      plugins: ["typescript"],
    });

    let modifications = [];
    traverse.default(ast, {
      TemplateLiteral({ node }) {
        // 检查是否在注释中
        if (
          node.leadingComments?.some(
            (comment) =>
              comment.type === "CommentBlock" || comment.type === "CommentLine"
          )
        ) {
          return;
        }

        const value = node.quasis
          .map((quasi, i) => {
            const text = quasi.value.raw;
            const expr = node.expressions[i]
              ? `\${${
                  node.expressions[i].name ||
                  node.expressions[i].property?.name ||
                  "props"
                }}`
              : "";
            return text + expr;
          })
          .join("");

        if (/[\u4e00-\u9fa5]/.test(value)) {
          const cleanText = value.replace(/\${[^}]+}/g, "{props}");
          const key = generateKey(cleanText, filePath);
          translations[key] = cleanText;

          const expressions = node.expressions
            .map((expr) => {
              if (expr.type === "MemberExpression") {
                return `${expr.object.name}.${expr.property.name}`;
              }
              return expr.name || "props";
            })
            .join(", ");

          modifications.push({
            start: node.start,
            end: node.end,
            replacement: `t("${key}", {props: ${expressions}})`,
          });
        }
      },
      StringLiteral({ node, parent }) {
        // 检查是否在注释中
        if (parent.type === "CommentBlock" || parent.type === "CommentLine") {
          return;
        }

        // 检查是否在console.log中
        if (
          parent.type === "CallExpression" &&
          parent.callee.type === "MemberExpression" &&
          parent.callee.object.name === "console" &&
          parent.callee.property.name === "log"
        ) {
          return;
        }

        if (/[\u4e00-\u9fa5]/.test(node.value)) {
          const key = generateKey(node.value, filePath);
          translations[key] = node.value;
          modifications.push({
            start: node.start,
            end: node.end,
            replacement: `t("${key}")`,
          });
        }
      },
    });

    // 从后往前替换，以保持位置的准确性
    modifications.sort((a, b) => b.start - a.start);
    let scriptContent = script;
    modifications.forEach(({ start, end, replacement }) => {
      scriptContent =
        scriptContent.slice(0, start) + replacement + scriptContent.slice(end);
    });

    result = result.replace(script, scriptContent);
  }

  writeFileSync(filePath, result, "utf-8");
}

// 处理TypeScript文件
function processJTScriptFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const ast = babelParse(content, {
    sourceType: "module",
    plugins: ["typescript"],
  });

  let modifications = [];
  traverse.default(ast, {
    TemplateLiteral({ node }) {
      // 检查是否在注释中
      if (
        node.leadingComments?.some(
          (comment) =>
            comment.type === "CommentBlock" || comment.type === "CommentLine"
        )
      ) {
        return;
      }

      const value = node.quasis
        .map((quasi, i) => {
          const text = quasi.value.raw;
          const expr = node.expressions[i]
            ? `\${${
                node.expressions[i].name ||
                node.expressions[i].property?.name ||
                "props"
              }}`
            : "";
          return text + expr;
        })
        .join("");

      if (/[\u4e00-\u9fa5]/.test(value)) {
        const cleanText = value.replace(/\${[^}]+}/g, "{props}");
        const key = generateKey(cleanText, filePath);
        translations[key] = cleanText;

        const expressions = node.expressions
          .map((expr) => {
            if (expr.type === "MemberExpression") {
              return `${expr.object.name}.${expr.property.name}`;
            }
            return expr.name || "props";
          })
          .join(", ");

        modifications.push({
          start: node.start,
          end: node.end,
          replacement: `t("${key}", {props: ${expressions}})`,
        });
      }
    },
    StringLiteral({ node, parent }) {
      // 检查是否在注释中
      if (parent.type === "CommentBlock" || parent.type === "CommentLine") {
        return;
      }

      // 检查是否在console.log中
      if (
        parent.type === "CallExpression" &&
        parent.callee.type === "MemberExpression" &&
        parent.callee.object.name === "console" &&
        parent.callee.property.name === "log"
      ) {
        return;
      }

      if (/[\u4e00-\u9fa5]/.test(node.value)) {
        const key = generateKey(node.value, filePath);
        translations[key] = node.value;
        modifications.push({
          start: node.start,
          end: node.end,
          replacement: `t("${key}")`,
        });
      }
    },
  });

  // 从后往前替换，以保持位置的准确性
  modifications.sort((a, b) => b.start - a.start);
  let result = content;
  modifications.forEach(({ start, end, replacement }) => {
    result = result.slice(0, start) + replacement + result.slice(end);
  });

  writeFileSync(filePath, result, "utf-8");
}

program
  .version("1.0.0")
  .argument("<source>", "要处理的文件或目录路径")
  .option("-o, --output <file>", "输出的翻译JSON文件路径", "translations.json")
  .action((source, options) => {
    try {
      // 如果输出文件已存在，先读取已有的翻译
      if (existsSync(options.output)) {
        const existingTranslations = JSON.parse(
          readFileSync(options.output, "utf-8")
        );
        Object.assign(translations, existingTranslations);
      }

      const files = globSync(path.resolve(source));

      files.forEach((file) => {
        if (file.endsWith(".vue")) {
          processVueFile(file);
        } else if (file.endsWith(".ts") || file.endsWith(".js")) {
          processJTScriptFile(file);
        }
      });

      // 保存翻译文件
      writeFileSync(
        options.output,
        JSON.stringify(translations, null, 2),
        "utf-8"
      );
      console.log(`处理完成！翻译已保存到 ${options.output}`);
    } catch (error) {
      console.error("处理过程中发生错误：", error);
      process.exit(1);
    }
  });

program.parse();
