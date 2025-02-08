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
          return "{props}";
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

    // 处理三元表达式中的中文字符串（需要先处理这个，避免与其他规则冲突）
    const ternaryRegex = /\{\{([^}]+)\}\}/g;
    processedTemplate = processedTemplate.replace(
      ternaryRegex,
      (match, expression) => {
        if (expression.includes("$t(")) return match;

        // 只处理包含引号的中文字符串
        if (!/['"].*[\u4e00-\u9fa5].*['"]/.test(expression)) return match;

        const processedExpression = expression.replace(
          /(['"])((?:(?!\1).)*[\u4e00-\u9fa5](?:(?!\1).)*)\1/g,
          (str, quote, text) => {
            const key = generateKey(text, filePath);
            translations[key] = text;
            return `$t("${key}")`;
          }
        );

        return `{{ ${processedExpression} }}`;
      }
    );

     // 处理包含中文和插值表达式的内容
     const mixedContentRegex = />([^<>]*?)(\{\{[\s\S]*?\}\}(?:[^<>]*?\{\{[\s\S]*?\}\})*)[^<>]*?</g;
     processedTemplate = processedTemplate.replace(
       mixedContentRegex,
       (match, before, interpolations) => {
         if (!/[\u4e00-\u9fa5]/.test(match)) return match;
         if (/\$t\(['"].*['"]\)/.test(match)) return match;
 
         const expressions = [];
         let template = '';
         let count = 1;
 
         // 提取所有文本和插值表达式
         const fullText = match.slice(1, -1); // 移除开头的>和结尾的<
         let currentText = '';
         let result = fullText;
 
         // 逐个处理每个插值表达式
         while (result.includes('{{')) {
           const startIdx = result.indexOf('{{');
           currentText += result.slice(0, startIdx);
           result = result.slice(startIdx);
           
           const endIdx = result.indexOf('}}') + 2;
           const expr = result.slice(2, endIdx - 2).trim();
           expressions.push(expr);
           
           currentText += `{props${count}}`;
           count++;
           
           result = result.slice(endIdx);
         }
         currentText += result;
 
         // 清理和格式化模板
         template = currentText.replace(/\s+/g, ' ').trim();
 
         if (/[\u4e00-\u9fa5]/.test(template)) {
           const key = generateKey(template, filePath);
           translations[key] = template;
           const propsObj = expressions
             .map((expr, index) => `props${index + 1}: ${expr}`)
             .join(", ");
           return `>{{ $t("${key}", { ${propsObj} }) }}<`;
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

          // 获取完整的表达式
          const expressions = node.expressions
            .map((expr) => {
              // 处理方法调用
              if (expr.type === "CallExpression") {
                return script.slice(expr.start, expr.end);
              }
              // 处理成员表达式
              if (expr.type === "MemberExpression") {
                return script.slice(expr.start, expr.end);
              }
              // 其他情况
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

    // 如果有中文被替换，添加 i18n 导入
    if (modifications.length > 0) {
      // 检查是否已经导入了 useI18n
      const hasI18nImport = script.includes(
        "import { useI18n } from 'vue-i18n'"
      );
      const hasI18nInit = script.includes("const { t } = useI18n()");
      if (!hasI18nImport && !hasI18nInit) {
        const importRegex = /^import .+$/gm;
        const matches = [...scriptContent.matchAll(importRegex)];
        if (matches.length > 0) {
          const lastImport = matches[matches.length - 1];
          const insertPosition = lastImport.index + lastImport[0].length;
          const i18nImport =
            "\nimport { useI18n } from 'vue-i18n'\nconst { t } = useI18n()\n";

          scriptContent =
            scriptContent.slice(0, insertPosition) +
            i18nImport +
            scriptContent.slice(insertPosition);
        }
      }
    }

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
