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
    if (fileName === 'index') {
        const parentDir = path.basename(path.dirname(filePath));
        prefix = parentDir;
    }
    
    // 生成6位哈希值
    const hash = createHash('md5').update(text).digest('hex').slice(0, 6);
    
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
        // 先处理HTML属性中的中文
        const attrChineseRegex = /(\s)(?!:|v-bind:)([a-zA-Z-]+)(=)(["'])([^"']*[\u4e00-\u9fa5]+[^"']*)\4/g;
        let processedTemplate = template.replace(attrChineseRegex, (match, space, attrName, equals, quote, text) => {
            if (text.trim()) {
                const key = generateKey(text, filePath);
                translations[key] = text;
                return `${space}:${attrName}="$t('${key}')"`;  // 转换为 Vue 绑定属性
            }
            return match;
        });

        // 再处理其他位置的中文
        const chineseRegex = /([\u4e00-\u9fa5]+(?:[^\u4e00-\u9fa5]*[\u4e00-\u9fa5]+)*)/g;
        processedTemplate = processedTemplate.replace(chineseRegex, (match, text) => {
            if (text.trim() && !/(\$t\(['"].*['"]\))/.test(match)) {
                const key = generateKey(text, filePath);
                translations[key] = text;
                return `{{ $t("${key}") }}`;
            }
            return match;
        });

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
            StringLiteral({ node, parent }) {
                // 检查是否在注释中
                if (parent.type === 'CommentBlock' || parent.type === 'CommentLine') {
                    return;
                }
                
                // 检查是否在console.log中
                if (parent.type === 'CallExpression' && 
                    parent.callee.type === 'MemberExpression' && 
                    parent.callee.object.name === 'console' && 
                    parent.callee.property.name === 'log') 
                {
                    return;
                }

                if (/[\u4e00-\u9fa5]/.test(node.value)) {
                    const key = generateKey(node.value, filePath);
                    translations[key] = node.value;
                    modifications.push({
                        start: node.start,
                        end: node.end,
                        replacement: `t("${key}")`
                    });
                }
            },
        });

        // 从后往前替换，以保持位置的准确性
        modifications.sort((a, b) => b.start - a.start);
        let scriptContent = script;
        modifications.forEach(({ start, end, replacement }) => {
            scriptContent =
                scriptContent.slice(0, start) +
                replacement +
                scriptContent.slice(end);
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
        StringLiteral({ node, parent }) {
                // 检查是否在注释中
                if (parent.type === 'CommentBlock' || parent.type === 'CommentLine') {
                    return;
                }
                
                // 检查是否在console.log中
                if (parent.type === 'CallExpression' && 
                    parent.callee.type === 'MemberExpression' && 
                    parent.callee.object.name === 'console' && 
                    parent.callee.property.name === 'log') 
                {
                    return;
                }

                if (/[\u4e00-\u9fa5]/.test(node.value)) {
                    const key = generateKey(node.value, filePath);
                    translations[key] = node.value;
                    modifications.push({
                        start: node.start,
                        end: node.end,
                        replacement: `t("${key}")`
                    });
                }
            }
        
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
    .option(
        "-o, --output <file>",
        "输出的翻译JSON文件路径",
        "translations.json"
    )
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
